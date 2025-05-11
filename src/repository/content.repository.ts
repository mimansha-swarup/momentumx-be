import { Firestore } from "firebase-admin/firestore";
import { COLLECTIONS } from "../constants/collection";
import { db, firebase } from "../config/firebase";
import { IGetTopicByUserIdArgs } from "../types/repository/content";

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
    limit = 10,
    cursor,
    filters,
  }: IGetTopicByUserIdArgs) => {
    try {
      let query = this.db
        .collection(this.collection)
        .where("createdBy", "==", userId);
      
        // Filtering
      if (filters.hasOwnProperty("isScriptGenerated")) {
        query = query.where(
          "isScriptGenerated",
          "==",
          filters.isScriptGenerated
        );
      }

      // Searching
      if (filters.searchText) {
        // Firestore does NOT support contains search or case-insensitive search directly
        // This is a workaround — in production, use Algolia or full-text search engine
        query = query.orderBy("title"); 
        query = query
          .startAt(filters.searchText)
          .endAt(filters.searchText + "\uf8ff");
      } else {
        query = query
          .orderBy("createdAt", "desc")
          .orderBy(firebase.firestore.FieldPath.documentId(), "desc");
      }
      query = query.limit(limit);
      if (cursor) {
        const { createdAt, docId } = cursor;
        query = query.startAfter(
          firebase.firestore.Timestamp.fromDate(new Date(createdAt)),
          docId
        );
      }
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

  batchSaveTopics = async (dataList: unknown[]) => {
    const batch = db.batch();
    const collectionRef = db.collection(this.collection);
    dataList?.forEach((data) => {
      const newDocRef = collectionRef.doc();
      batch.set(newDocRef, { ...(data as {}), id: newDocRef.id });
    });
    try {
      await batch.commit();
      console.log("✅ Successfully added all documents");
    } catch (err) {
      console.error("❌ Failed to batch create documents", err);
      throw err;
    }
  };

  updateTopic = async (topicId: string, data: Record<string, unknown>) => {
    try {
      await this.db.collection(this.collection).doc(topicId).update(data);
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
