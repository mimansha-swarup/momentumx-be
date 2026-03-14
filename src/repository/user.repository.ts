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
    try {
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
    } catch (error) {
      console.log("error in add", error);
    }
  };
  update = async (userId: string, data: unknown) => {
    try {
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
    } catch (error) {
      console.log("error", error);
    }
  };

  get = async (userId: string) => {
    try {
      const doc = await this.db.collection(this.collection).doc(userId).get();
      return doc.data();
    } catch (error) {
      console.log("error", error);
    }
  };

}

export default UserRepository;
