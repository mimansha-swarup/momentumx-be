import { Firestore } from "firebase-admin/firestore";
import { COLLECTIONS } from "../constants/collection.js";
import { db, firebase } from "../config/firebase.js";
import { IGetTopicByUserIdArgs } from "../types/repository/content.js";

class ContentRepository {
  private collection: `${COLLECTIONS}`;
  private script_collection: `${COLLECTIONS}`;
  private db: Firestore;
  constructor() {
    this.db = db;
    this.collection = COLLECTIONS.TOPICS;
    this.script_collection = COLLECTIONS.SCRIPTS;
  }
  getTopic = async (topicId: string) => {
    try {
      const doc = await this.db.collection(this.collection).doc(topicId).get();
      return doc.data();
    } catch (error) {
      console.log("error", error);
    }
  };

  getTopics = async ({
    userId,
    limit = 8,
    cursor,
    filters,
  }: IGetTopicByUserIdArgs) => {
    try {
      let query = this.db
        .collection(this.collection)
        .where("createdBy", "==", userId);

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
      console.log("error in repo", error);
    }
  };
  getAllTopics = async ({ userId = "" }) => {
    try {
      let query = this.db
        .collection(this.collection)
        .where("createdBy", "==", userId);

      const snapshot = await query.get();

      return snapshot.docs.map((doc) => doc.data());
    } catch (error) {
      console.log("error in repo", error);
    }
  };

  getScripts = async (userId: string) => {
    try {
      const snapshot = await this.db
        .collection(this.script_collection)
        .where("createdBy", "==", userId)
        .orderBy("createdAt", "desc")
        .get();
      const docs = snapshot.docs.map((doc) => {
        const data = doc.data();
        return {
          ...data,
          id: doc.id,
          createdAt: data.createdAt?.toDate(),
        };
      });

      return docs;
    } catch (error) {
      console.log("error in repo", error);
    }
  };
  getScriptById = async (scriptId: string) => {
    try {
      const snapshot = await this.db
        .collection(this.script_collection)
        .doc(scriptId)
        .get();

      if (!snapshot.exists) {
        return null;
      }

      const data = snapshot.data();
      data.createdAt = data.createdAt?.toDate();

      return data;
    } catch (error) {
      console.log("error in repo", error);
    }
  };

  batchSaveTopics = (dataList: unknown[]) => {
    const batch = db.batch();
    const collectionRef = db.collection(this.collection);

    const updatedDataList = dataList?.map((data) => {
      const newDocRef = collectionRef.doc();
      const dataWithId = { ...(data as {}), id: newDocRef.id };
      batch.set(newDocRef, dataWithId);
      return dataWithId;
    });
    try {
      batch.commit();
      return updatedDataList;
    } catch (err) {
      console.error("❌ Failed to batch create documents", err);
      throw err;
    }
  };

  updateTopic = async (topicId: string, data: Record<string, unknown>) => {
    try {
      await this.db
        .collection(this.collection)
        .doc(topicId)
        .set(data, { merge: true });
    } catch (error) {
      console.log("error", error);
    }
  };

  editScript = async (scriptId: string, data: Record<string, unknown>) => {
    try {
      await this.db
        .collection(this.script_collection)
        .doc(scriptId)
        .set(data, { merge: true });
    } catch (error) {
      console.log("error", error);
    }
  };

  saveScript = async (scriptId: string, data: unknown) => {
    try {
      await this.db
        .collection(this.script_collection)
        .doc(scriptId)
        .set(data, { merge: true });
    } catch (error) {
      console.log("error", error);
    }
  };
}

export default ContentRepository;
