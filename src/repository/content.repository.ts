import { Firestore } from "firebase-admin/firestore";
import { COLLECTIONS } from "../constants/collection";
import { db, firebase } from "../config/firebase";

class ContentRepository {
  private collection: `${COLLECTIONS}`;
  private db: Firestore;
  constructor() {
    this.db = db;
    this.collection = COLLECTIONS.TOPICS;
  }
  getTopics = async (userId: string) => {
    try {
      const doc = await this.db.collection(this.collection).doc(userId).get();
      return doc.data();
    } catch (error) {
      console.log("error", error);
    }
  };

  getTopicsByUid = async (userId: string) => {
    try {
      const doc = await this.db.collection(this.collection).doc(userId).get();
      // .where("", "==", userId) // get this logic fixed
      // .get();
      return doc.data();
    } catch (error) {
      console.log("error", error);
    }
  };

  saveTopics = async (userId: string, data: unknown[]) => {
    try {
      await this.db
        .collection(this.collection)
        .doc(userId)
        .set(
          {
            data: firebase.firestore.FieldValue.arrayUnion(...data),
          },
          { merge: true }
        );
    } catch (error) {
      console.log("error", error);
    }
  };
}

export default ContentRepository;
