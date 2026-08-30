import { isDocumentId } from "../utlils/firestore-id.js";
import { Firestore } from "firebase-admin/firestore";
import { COLLECTIONS } from "../constants/collection.js";
import { db, firebase } from "../config/firebase.js";
import { IGetIdeaQueryArgs } from "../types/repository/content.js";
import { IIdea, IScript } from "../types/routes/content.js";

class ContentRepository {
  private collection: `${COLLECTIONS}`;
  private script_collection: `${COLLECTIONS}`;
  private db: Firestore;
  constructor() {
    this.db = db;
    this.collection = COLLECTIONS.IDEAS;
    this.script_collection = COLLECTIONS.SCRIPTS;
  }
  getIdea = async (ideaId: string): Promise<IIdea | undefined> => {
    // A route param reaching `.doc()` unchecked: `GET /v1/…/a%2Fb` decodes to
    // "a/b", which addresses a COLLECTION and throws a bare Error — rendered as
    // 500 "Something went wrong" where the honest answer is not-found.
    if (!isDocumentId(ideaId)) return undefined;
    const doc = await this.db.collection(this.collection).doc(ideaId).get();
    return doc.data() as IIdea | undefined;
  };

  getIdeas = async ({
    accountId,
    limit = 8,
    cursor,
    filters,
  }: IGetIdeaQueryArgs) => {
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
        query = query.where(
          "isScriptGenerated",
          "==",
          filters.isScriptGenerated
        );
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
          .orderBy("title")
          .orderBy(firebase.firestore.FieldPath.documentId());

        // `endAt` keeps the prefix bound; `startAfter` moves past the previous
        // page's last row. Both apply together — the upper bound is what makes it
        // a prefix search, the lower bound is what makes it page.
        //
        // docId is the tiebreaker: two ideas can share a title, and without it
        // `startAfter(title)` would skip every duplicate after the first.
        if (cursor?.title && cursor?.docId) {
          query = query.startAfter(cursor.title, cursor.docId);
        } else {
          query = query.startAt(filters.searchText);
        }

        query = query.endAt(filters.searchText + "\uf8ff");
      } else {
        // ONE ordering for page 1 and every cursor page. This orderBy used to live
        // only in the cursor branch, so page 1 came back in Firestore's default
        // document-id order while page 2 ranged over `createdAt desc` \u2014 different
        // sorts either side of the cursor, which made "Load More" re-show ideas
        // already on screen and left others unreachable for good.
        query = query
          .orderBy("createdAt", "desc")
          .orderBy(firebase.firestore.FieldPath.documentId(), "desc");

        if (cursor?.createdAt && cursor?.docId) {
          query = query.startAfter(
            firebase.firestore.Timestamp.fromDate(new Date(cursor.createdAt)),
            cursor.docId
          );
        }
      }

      query = query.limit(limit);
      const snapshot = await query.get();

      return snapshot.docs.map((doc) => doc.data());
    } catch (error) {
      throw error;
    }
  };
  // Bounded read for KMeans clustering — projects to title + embedding only and
  // caps at 200 docs at the query level so we never pull every embedding array.
  getIdeasForClustering = async (
    accountId: string,
  ): Promise<Pick<IIdea, "title" | "embedding">[]> => {
    const snapshot = await this.db
      .collection(this.collection)
      .where("accountId", "==", accountId)
      .where("archived", "==", false)
      .limit(200)
      .select("title", "embedding")
      .get();
    return snapshot.docs.map(
      (doc) => doc.data() as Pick<IIdea, "title" | "embedding">,
    );
  };

  getScripts = async (accountId: string): Promise<IScript[]> => {
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
        return data as IScript;
      });
    } catch (error) {
      throw error;
    }
  };
  getScriptById = async (scriptId: string): Promise<IScript | null> => {
    // A route param reaching `.doc()` unchecked: `GET /v1/…/a%2Fb` decodes to
    // "a/b", which addresses a COLLECTION and throws a bare Error — rendered as
    // 500 "Something went wrong" where the honest answer is not-found.
    if (!isDocumentId(scriptId)) return null;
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
    return data as IScript;
  };

  batchSaveIdeas = async (dataList: unknown[]) => {
    const batch = db.batch();
    const collectionRef = db.collection(this.collection);

    const updatedDataList = (dataList ?? []).map((data) => {
      const idea = data as { id?: string } & Record<string, unknown>;
      // Ideas convention: doc id = the UUID generated in formatGeneratedTitle.
      // Fall back to a Firestore auto-id only if no id was supplied.
      const docId =
        typeof idea.id === "string" && idea.id
          ? idea.id
          : collectionRef.doc().id;
      const dataWithId = { ...idea, id: docId };
      batch.set(collectionRef.doc(docId), dataWithId);
      return dataWithId;
    });
    try {
      await batch.commit();
      return updatedDataList;
    } catch (err) {
      console.error("❌ Failed to batch create documents", err);
      throw err;
    }
  };

  // Active batch for regenerate/export — excludes embeddings (not needed here).
  getActiveBatch = async (
    accountId: string,
  ): Promise<Pick<IIdea, "id" | "title" | "concept" | "ideaType" | "createdAt" | "videoProjectId">[]> => {
    const snapshot = await this.db
      .collection(this.collection)
      .where("accountId", "==", accountId)
      .where("archived", "==", false)
      .select("title", "concept", "ideaType", "createdAt", "videoProjectId")
      .get();
    return snapshot.docs.map((doc) => {
      const data = doc.data();
      data.id = doc.id;
      return data as Pick<IIdea, "id" | "title" | "concept" | "ideaType" | "createdAt" | "videoProjectId">;
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
  archiveUserIdeas = async (accountId: string, excludeBatchId?: string) => {
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

      if (snapshot.empty) return;

      const toArchive = snapshot.docs.filter(
        (doc) => !excludeBatchId || doc.data().batchId !== excludeBatchId
      );

      // Everything still active belongs to the excluded batch — nothing left to do.
      // Without this the loop would re-read the same page forever.
      if (toArchive.length === 0) return;

      const batch = db.batch();
      toArchive.forEach((doc) => {
        batch.update(doc.ref, {
          archived: true,
          updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
        });
      });
      await batch.commit();

      // A short page means we reached the end of what matched.
      if (snapshot.size < CHUNK_SIZE) return;
    }

    console.warn(
      JSON.stringify({ event: "archive_max_passes_reached", accountId, maxPasses: MAX_PASSES })
    );
  };

  updateIdea = async (ideaId: string, data: Record<string, unknown>) => {
    await this.db
      .collection(this.collection)
      .doc(ideaId)
      .set(data, { merge: true });
  };

  editScript = async (scriptId: string, data: Record<string, unknown>) => {
    await this.db
      .collection(this.script_collection)
      .doc(scriptId)
      .set(data, { merge: true });
  };

  saveScript = async (scriptId: string, data: Record<string, unknown>) => {
    await this.db
      .collection(this.script_collection)
      .doc(scriptId)
      .set(data, { merge: true });
  };
}

export default ContentRepository;
