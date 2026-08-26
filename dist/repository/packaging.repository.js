import { db, firebase } from "../config/firebase.js";
class PackagingRepository {
    constructor() {
        /**
         * Create the packaging document for a project, keyed on `videoProjectId`.
         *
         * Phase 05a. This replaced an auto-ID `doc()` create. Two creation paths with
         * two different keys is what made `findByVideoProject` necessary at all:
         * `upsertGeneratedItem` has always used `doc(videoProjectId)`, while the save
         * path minted auto-IDs, so nothing could assume `id === videoProjectId`.
         *
         * `merge: true` because persist-on-generate may already have created the
         * document for this project — overwriting would drop the generated items.
         */
        this.saveWithId = async (videoProjectId, data) => {
            const docRef = this.db.collection(this.collection).doc(videoProjectId);
            const dataWithId = { ...data, id: videoProjectId };
            await docRef.set(dataWithId, { merge: true });
            return dataWithId;
        };
        this.get = async (packagingId) => {
            try {
                const doc = await this.db
                    .collection(this.collection)
                    .doc(packagingId)
                    .get();
                if (!doc.exists) {
                    return null;
                }
                const data = doc.data();
                if (data?.createdAt) {
                    data.createdAt = data.createdAt?.toDate();
                }
                return data ?? null;
            }
            catch (error) {
                throw error;
            }
        };
        this.getByUserId = async (userId) => {
            try {
                const snapshot = await this.db
                    .collection(this.collection)
                    .where("createdBy", "==", userId)
                    .orderBy("createdAt", "desc")
                    .get();
                return snapshot.docs.map((doc) => {
                    const data = doc.data();
                    return {
                        ...data,
                        id: doc.id,
                        createdAt: data.createdAt?.toDate(),
                    };
                });
            }
            catch (error) {
                throw error;
            }
        };
        this.update = async (packagingId, data) => {
            try {
                await this.db
                    .collection(this.collection)
                    .doc(packagingId)
                    .update(data);
                return { id: packagingId, ...data };
            }
            catch (error) {
                throw error;
            }
        };
        // Atomic "generation writes its item to the doc" for the persist-on-generate
        // flow. Keyed on a DETERMINISTIC id (= videoProjectId) so two first-generations
        // racing (round 1 title+shorts) converge on ONE doc instead of creating two
        // auto-id docs; legacy/door docs (auto-id) are located by query and updated in
        // place. The transaction makes the itemStatuses read-modify-write and the
        // "all four done?" check see a consistent snapshot, so concurrent final writes
        // can't both skip completion. Returns whether it created the doc and whether
        // the whole set is now complete (so the service can drive the pipeline step).
        this.upsertGeneratedItem = async (videoProjectId, 
        // An OBJECT, not two positional strings — `userId` and `accountId` are both
        // strings, so a sixth `accountId: string` parameter would let an existing
        // 5-argument call keep compiling with the wrong value in the slot.
        { userId, accountId }, field, item, canonical) => {
            return this.db.runTransaction(async (txn) => {
                // A point read, because the id IS the videoProjectId. This used to be a
                // `where("videoProjectId", "==", ...)` query, which existed only to find
                // documents the old auto-ID save path had written — there are none.
                //
                // The read stays INSIDE the transaction for a different reason (Phase 01
                // item 3): persist-on-generate fires four item writes concurrently, so the
                // itemStatuses read-modify-write and the "all four done?" check below have
                // to see a consistent snapshot. Outside it, two concurrent final writes
                // both read an incomplete set and neither completes the step.
                const ref = this.db.collection(this.collection).doc(videoProjectId);
                const snap = await txn.get(ref);
                const statuses = {
                    title: "not_started",
                    description: "not_started",
                    thumbnail: "not_started",
                    shorts: "not_started",
                    ...(snap.exists ? (snap.data()?.itemStatuses ?? {}) : {}),
                    [item]: "completed",
                };
                if (!snap.exists) {
                    txn.set(ref, {
                        id: ref.id,
                        createdBy: userId,
                        accountId,
                        videoProjectId,
                        titles: [],
                        description: "",
                        thumbnail: [],
                        shorts: { segments: [], totalDuration: "" },
                        selectedTitleIndex: null,
                        selectedThumbnailIndex: 0,
                        isStale: false,
                        staleReason: null,
                        staleSince: null,
                        [field]: canonical,
                        itemStatuses: statuses,
                        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
                    });
                }
                else {
                    txn.update(ref, {
                        [field]: canonical,
                        [`itemStatuses.${item}`]: "completed",
                        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
                    });
                }
                // Return the consistent in-transaction status snapshot; the service decides
                // step completion (packaging = its 3 items; title completes on select).
                return { packagingId: ref.id, created: !snap.exists, statuses };
            });
        };
        // Inverse of markStale, for the "Keep as-is" path: the creator accepted the
        // content as-is, so the doc must stop reporting stale or every card keeps an
        // "Outdated" chip under a banner they already dismissed.
        // Phase 01 item 3. Both of these used to read `itemStatuses`, rebuild it in
        // memory and write the WHOLE map back. Any item that changed in the gap — a
        // regenerate completing mid-cascade — was reverted by the write, because the
        // map being written was computed from a snapshot that no longer matched.
        //
        // Two changes: the read and the write now share a transaction, and only the
        // keys that actually flip are written, as dotted paths. `upsertGeneratedItem`
        // already used dotted paths; these two just didn't follow the pattern. An item
        // this call doesn't touch is now untouched in the write, not rewritten to the
        // value it happened to have when we looked.
        this.transitionItemStatuses = async (packagingId, from, to, docFields) => {
            const ref = this.db.collection(this.collection).doc(packagingId);
            await this.db.runTransaction(async (txn) => {
                const doc = await txn.get(ref);
                if (!doc.exists)
                    return;
                const currentStatuses = (doc.data()?.itemStatuses ?? {});
                const updates = { ...docFields };
                for (const key of ["title", "description", "thumbnail", "shorts"]) {
                    if ((currentStatuses[key] ?? "not_started") === from) {
                        updates[`itemStatuses.${key}`] = to;
                    }
                }
                txn.update(ref, updates);
            });
        };
        // Inverse of markStale, for the "Keep as-is" path: the creator accepted the
        // content as-is, so the doc must stop reporting stale or every card keeps an
        // "Outdated" chip under a banner they already dismissed.
        this.clearStale = async (packagingId) => {
            await this.transitionItemStatuses(packagingId, "stale", "completed", {
                isStale: false,
                staleReason: null,
                staleSince: null,
            });
        };
        this.markStale = async (packagingId, reason) => {
            await this.transitionItemStatuses(packagingId, "completed", "stale", {
                isStale: true,
                staleReason: reason,
                staleSince: firebase.firestore.FieldValue.serverTimestamp(),
            });
        };
        this.db = db;
        this.collection = "packaging" /* COLLECTIONS.PACKAGING */;
    }
}
export default PackagingRepository;
