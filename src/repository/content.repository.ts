import { Firestore } from "firebase-admin/firestore";
import { COLLECTIONS } from "../constants/collection.js";
import { db, firebase } from "../config/firebase.js";
import { IGetIdeaByUserIdArgs } from "../types/repository/content.js";
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
    const doc = await this.db.collection(this.collection).doc(ideaId).get();
    return doc.data() as IIdea | undefined;
  };

  getIdeas = async ({
    userId,
    limit = 8,
    cursor,
    filters,
  }: IGetIdeaByUserIdArgs) => {
    try {
      let query = this.db
        .collection(this.collection)
        .where("createdBy", "==", userId)
        // Active batch only — archived ideas must never appear in the list
        .where("archived", "==", false);

      // Optional filtering
      if (
        filters.hasOwnProperty("isScriptGenerated") &&
        filters?.isScriptGenerated
      ) {
        query = query.where(
          "isScriptGenerated",
          "==",
          filters.isScriptGenerated
        );
      }

      if (filters.searchText) {
        // Prefix search using title
        query = query.orderBy("title");
        query = query
          .startAt(filters.searchText)
          .endAt(filters.searchText + "\uf8ff");
      }

      // Pagination
      else if (cursor?.createdAt && cursor?.docId) {
        // Default ordering if no search
        query = query
          .orderBy("createdAt", "desc")
          .orderBy(firebase.firestore.FieldPath.documentId(), "desc");
        query = query.startAfter(
          firebase.firestore.Timestamp.fromDate(new Date(cursor.createdAt)),
          cursor.docId
        );
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
    userId: string,
  ): Promise<Pick<IIdea, "title" | "embedding">[]> => {
    const snapshot = await this.db
      .collection(this.collection)
      .where("createdBy", "==", userId)
      .where("archived", "==", false)
      .limit(200)
      .select("title", "embedding")
      .get();
    return snapshot.docs.map(
      (doc) => doc.data() as Pick<IIdea, "title" | "embedding">,
    );
  };

  getScripts = async (userId: string): Promise<IScript[]> => {
    try {
      const snapshot = await this.db
        .collection(this.script_collection)
        .where("createdBy", "==", userId)
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
    userId: string,
  ): Promise<Pick<IIdea, "id" | "title" | "concept" | "ideaType" | "createdAt" | "videoProjectId">[]> => {
    const snapshot = await this.db
      .collection(this.collection)
      .where("createdBy", "==", userId)
      .where("archived", "==", false)
      .select("title", "concept", "ideaType", "createdAt", "videoProjectId")
      .get();
    return snapshot.docs.map((doc) => {
      const data = doc.data();
      data.id = doc.id;
      return data as Pick<IIdea, "id" | "title" | "concept" | "ideaType" | "createdAt" | "videoProjectId">;
    });
  };

  archiveUserIdeas = async (userId: string, excludeBatchId?: string) => {
    const snapshot = await this.db
      .collection(this.collection)
      .where("createdBy", "==", userId)
      .where("archived", "==", false)
      .select("batchId")
      .get();

    const toArchive = snapshot.docs.filter(
      (doc) => !excludeBatchId || doc.data().batchId !== excludeBatchId
    );

    if (toArchive.length === 0) return;

    // Firestore caps a batch at 500 ops — chunk so large batches never throw.
    const CHUNK_SIZE = 450;
    for (let i = 0; i < toArchive.length; i += CHUNK_SIZE) {
      const batch = db.batch();
      toArchive.slice(i, i + CHUNK_SIZE).forEach((doc) => {
        batch.update(doc.ref, {
          archived: true,
          updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
        });
      });
      await batch.commit();
    }
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
