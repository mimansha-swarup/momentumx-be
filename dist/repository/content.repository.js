import { IDEA_PUBLIC_FIELDS } from "../utlils/public-response.js";
import { generationWrite } from "./generation-guard.js";
import { isDocumentId } from "../utlils/firestore-id.js";
import { db, firebase } from "../config/firebase.js";
import { ServiceUnavailable } from "../utlils/errors.js";
class ContentRepository {
    constructor() {
        this.getIdea = async (ideaId) => {
            // A route param reaching `.doc()` unchecked: `GET /v1/…/a%2Fb` decodes to
            // "a/b", which addresses a COLLECTION and throws a bare Error — rendered as
            // 500 "Something went wrong" where the honest answer is not-found.
            if (!isDocumentId(ideaId))
                return undefined;
            const doc = await this.db.collection(this.collection).doc(ideaId).get();
            return doc.data();
        };
        this.getIdeas = async ({ accountId, limit = 8, cursor, filters, }) => {
            try {
                let query = this.db
                    .collection(this.collection)
                    .where("accountId", "==", accountId)
                    // Active batch only — archived ideas must never appear in the list
                    .where("archived", "==", false);
                // Optional filtering. Test the TYPE, not truthiness: the previous guard
                // (`hasOwnProperty(...) && filters.isScriptGenerated`) could not represent a
                // deliberate `false`, so "ideas I haven't scripted yet" silently fell
                // through and returned everything. Absent → no filter; false → only
                // unscripted; true → only scripted.
                if (typeof filters.isScriptGenerated === "boolean") {
                    query = query.where("isScriptGenerated", "==", filters.isScriptGenerated);
                }
                if (filters.searchText) {
                    // Prefix search on title. Firestore requires the range field to be the
                    // first ordering, so this branch orders by `title` — which means it needs
                    // a DIFFERENT cursor from the default branch. `(createdAt, docId)` is
                    // meaningless against a title ordering.
                    //
                    // That mismatch is why this branch used to ignore the cursor entirely and
                    // re-return page 1 forever: the cursor it was handed did not fit its sort.
                    query = query
                        // Keep the prefix filter independent of the pagination cursor. A
                        // cursor from an earlier search must not widen these results.
                        .where("title", ">=", filters.searchText)
                        .where("title", "<=", filters.searchText + "\uf8ff")
                        .orderBy("title")
                        .orderBy(firebase.firestore.FieldPath.documentId());
                    // docId is the tiebreaker: two ideas can share a title, and without it
                    // `startAfter(title)` would skip every duplicate after the first.
                    if (cursor?.title && cursor?.docId) {
                        query = query.startAfter(cursor.title, cursor.docId);
                    }
                }
                else {
                    // ONE ordering for page 1 and every cursor page. This orderBy used to live
                    // only in the cursor branch, so page 1 came back in Firestore's default
                    // document-id order while page 2 ranged over `createdAt desc` \u2014 different
                    // sorts either side of the cursor, which made "Load More" re-show ideas
                    // already on screen and left others unreachable for good.
                    query = query
                        .orderBy("createdAt", "desc")
                        .orderBy(firebase.firestore.FieldPath.documentId(), "desc");
                    if (cursor?.createdAt && cursor?.docId) {
                        query = query.startAfter(firebase.firestore.Timestamp.fromDate(new Date(cursor.createdAt)), cursor.docId);
                    }
                }
                query = query.select(...IDEA_PUBLIC_FIELDS).limit(limit);
                const snapshot = await query.get();
                // Pagination and later edits address the document, not a legacy stored id.
                return snapshot.docs.map((doc) => {
                    const data = doc.data();
                    data.id = doc.id;
                    return data;
                });
            }
            catch (error) {
                throw error;
            }
        };
        // Bounded read for KMeans clustering — projects to title + embedding only and
        // caps at 200 docs at the query level so we never pull every embedding array.
        this.getIdeasForClustering = async (accountId) => {
            const snapshot = await this.db
                .collection(this.collection)
                .where("accountId", "==", accountId)
                .where("archived", "==", false)
                .limit(200)
                .select("title", "embedding")
                .get();
            return snapshot.docs.map((doc) => doc.data());
        };
        this.getScripts = async (accountId) => {
            try {
                const snapshot = await this.db
                    .collection(this.script_collection)
                    .where("accountId", "==", accountId)
                    .orderBy("createdAt", "desc")
                    .get();
                return snapshot.docs.map((doc) => {
                    const data = doc.data();
                    data.id = doc.id;
                    data.createdAt = data.createdAt?.toDate();
                    return data;
                });
            }
            catch (error) {
                throw error;
            }
        };
        this.getScriptById = async (scriptId) => {
            // A route param reaching `.doc()` unchecked: `GET /v1/…/a%2Fb` decodes to
            // "a/b", which addresses a COLLECTION and throws a bare Error — rendered as
            // 500 "Something went wrong" where the honest answer is not-found.
            if (!isDocumentId(scriptId))
                return null;
            const snapshot = await this.db
                .collection(this.script_collection)
                .doc(scriptId)
                .get();
            if (!snapshot.exists) {
                return null;
            }
            const data = snapshot.data();
            if (!data) {
                return null;
            }
            data.createdAt = data.createdAt?.toDate();
            return data;
        };
        this.batchSaveIdeas = async (dataList, charge, replaceAccountId) => {
            const batch = db.batch();
            const collectionRef = db.collection(this.collection);
            const updatedDataList = (dataList ?? []).map((data) => {
                const idea = data;
                // Ideas convention: doc id = the UUID generated in formatGeneratedTitle.
                // Fall back to a Firestore auto-id only if no id was supplied.
                const docId = typeof idea.id === "string" && idea.id
                    ? idea.id
                    : collectionRef.doc().id;
                const dataWithId = { ...idea, id: docId };
                batch.set(collectionRef.doc(docId), dataWithId);
                return dataWithId;
            });
            try {
                if (replaceAccountId && (!updatedDataList.length || updatedDataList.some(data => data.accountId !== replaceAccountId) || (charge && charge.accountId !== replaceAccountId))) {
                    throw new Error("Replacement ideas must belong to the channel being replaced");
                }
                const write = async (tx) => {
                    // Archive and deliver in one commit so every active-list reader sees
                    // either the previous slate or its replacement, even after a crash.
                    const previous = replaceAccountId ? await tx.get(collectionRef
                        .where("accountId", "==", replaceAccountId).where("archived", "==", false)
                        .select("archived").limit(451)) : undefined;
                    // Application bound, not a provider limit: keep the atomic operation
                    // finite without chunking it into partially visible replacements.
                    if (previous && previous.size + updatedDataList.length > 450) {
                        throw ServiceUnavailable("Too many active ideas to replace at once. Your existing ideas are unchanged.");
                    }
                    previous?.docs.forEach(doc => tx.update(doc.ref, { archived: true }));
                    updatedDataList.forEach(data => tx.set(collectionRef.doc(data.id), data));
                };
                if (charge)
                    await generationWrite(charge, write, updatedDataList.length > 0);
                else if (replaceAccountId)
                    await this.db.runTransaction(write);
                else
                    await batch.commit();
                return updatedDataList;
            }
            catch (err) {
                console.error("❌ Failed to batch create documents", err);
                throw err;
            }
        };
        // Active batch for regenerate/export — excludes embeddings (not needed here).
        this.getActiveBatch = async (accountId) => {
            const snapshot = await this.db
                .collection(this.collection)
                .where("accountId", "==", accountId)
                .where("archived", "==", false)
                .select("title", "concept", "ideaType", "createdAt", "videoProjectId")
                .get();
            return snapshot.docs.map((doc) => {
                const data = doc.data();
                data.id = doc.id;
                return data;
            });
        };
        // Phase 01 item 4. This used to take ONE snapshot of everything active and then
        // archive it in chunks. An idea created after that snapshot — a concurrent
        // generation, or simply a slow archive over many chunks — was never seen, stayed
        // active, and surfaced mixed into the next batch.
        //
        // Re-querying per chunk closes that: each pass asks for what is *still* active,
        // so records that appeared mid-run are picked up by a later pass. The loop
        // terminates because every pass archives the page it just read, which
        // permanently removes those documents from `archived == false`.
        this.archiveUserIdeas = async (accountId, excludeBatchId, charge) => {
            // Firestore caps a batch at 500 ops — stay under it so a commit never throws.
            const CHUNK_SIZE = 450;
            // A generation writes 10 ideas, so this is far more headroom than any real
            // run needs; it exists so a bug can't spin here forever.
            const MAX_PASSES = 200;
            for (let pass = 0; pass < MAX_PASSES; pass++) {
                const snapshot = await this.db
                    .collection(this.collection)
                    .where("accountId", "==", accountId)
                    .where("archived", "==", false)
                    .select("batchId")
                    .limit(CHUNK_SIZE)
                    .get();
                if (snapshot.empty)
                    return;
                const toArchive = snapshot.docs.filter((doc) => !excludeBatchId || doc.data().batchId !== excludeBatchId);
                // Everything still active belongs to the excluded batch — nothing left to do.
                // Without this the loop would re-read the same page forever.
                if (toArchive.length === 0)
                    return;
                const batch = db.batch();
                toArchive.forEach((doc) => {
                    batch.update(doc.ref, {
                        archived: true,
                        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
                    });
                });
                if (charge)
                    await generationWrite(charge, tx => toArchive.forEach(doc => tx.update(doc.ref, { archived: true, updatedAt: firebase.firestore.FieldValue.serverTimestamp() })));
                else
                    await batch.commit();
                // A short page means we reached the end of what matched.
                if (snapshot.size < CHUNK_SIZE)
                    return;
            }
            console.warn(JSON.stringify({ event: "archive_max_passes_reached", accountId, maxPasses: MAX_PASSES }));
        };
        this.updateIdea = async (ideaId, data, charge) => {
            const ref = this.db.collection(this.collection).doc(ideaId);
            if (charge)
                await generationWrite(charge, tx => tx.set(ref, data, { merge: true }), charge.kind === "ideas");
            else
                await ref.set(data, { merge: true });
        };
        this.editScript = async (scriptId, data, charge) => {
            const ref = this.db.collection(this.script_collection).doc(scriptId);
            if (charge)
                await generationWrite(charge, tx => tx.set(ref, data, { merge: true }), true);
            else
                await ref.set(data, { merge: true });
        };
        this.saveScript = async (scriptId, data, charge) => {
            const ref = this.db.collection(this.script_collection).doc(scriptId);
            if (charge)
                await generationWrite(charge, tx => {
                    tx.set(ref, data, { merge: true });
                    if (charge.projectId)
                        tx.update(this.db.collection("videoProjects" /* COLLECTIONS.VIDEO_PROJECTS */).doc(charge.projectId), { scriptId });
                }, true);
            else
                await ref.set(data, { merge: true });
        };
        this.db = db;
        this.collection = "ideas" /* COLLECTIONS.IDEAS */;
        this.script_collection = "scripts" /* COLLECTIONS.SCRIPTS */;
    }
}
export default ContentRepository;
