import { Firestore } from "firebase-admin/firestore";
import { db, firebase } from "../config/firebase.js";
import { COLLECTIONS } from "../constants/collection.js";

class UserRepository {
  private db: Firestore;
  private collection: `${COLLECTIONS}`;

  constructor() {
    this.db = db;
    this.collection = COLLECTIONS.USERS;
  }

  add = async (userId: string, data: unknown) => {
    if (!userId) {
      throw new Error("userId is required");
    }
    await this.db
      .collection(this.collection)
      .doc(userId)
      .set(
        {
          ...(data as Record<string, unknown>),
          createdAt: firebase.firestore.FieldValue.serverTimestamp(),
          updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
  };

  update = async (userId: string, data: unknown) => {
    if (!userId) {
      throw new Error("userId is required");
    }
    await this.db
      .collection(this.collection)
      .doc(userId)
      .update({
        ...(data as Record<string, unknown>),
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      });
  };

  get = async (userId: string) => {
    const doc = await this.db.collection(this.collection).doc(userId).get();
    return doc.data();
  };

}

export default UserRepository;
