import { Firestore } from "firebase-admin/firestore";
import { COLLECTIONS } from "../constants/collection";
import { db, firebase } from "../config/firebase";

class ContentRepository {
  private collection: `${COLLECTIONS}`;
  private script_collection: `${COLLECTIONS}`;
  private db: Firestore;
  constructor() {
    this.db = db;
    this.collection = COLLECTIONS.TOPICS;
    this.script_collection = COLLECTIONS.SCRIPTS;
  }
  getTopics = async (topicId: string) => {
    try {
      const doc = await this.db.collection(this.collection).doc(topicId).get();
      return doc.data();
    } catch (error) {
      console.log("error", error);
    }
  };

  getTopicsByUid = async (userId: string) => {
    try {
      const snapshot = await this.db
        .collection(this.collection)
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
      await this.db
        .collection(this.collection)
        .doc(topicId)
        .update(data, );
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

  getScriptsByUid = async (userId: string) => {
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
}

export default ContentRepository;
