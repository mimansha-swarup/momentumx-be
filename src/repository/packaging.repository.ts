import { Firestore } from "firebase-admin/firestore";
import { COLLECTIONS } from "../constants/collection.js";
import { db } from "../config/firebase.js";

class PackagingRepository {
  private collection: `${COLLECTIONS}`;
  private db: Firestore;

  constructor() {
    this.db = db;
    this.collection = COLLECTIONS.PACKAGING;
  }

  save = async (data: Record<string, unknown>) => {
    try {
      const docRef = this.db.collection(this.collection).doc();
      const dataWithId = { ...data, id: docRef.id };
      await docRef.set(dataWithId);
      return dataWithId;
    } catch (error) {
      console.log("error saving packaging", error);
      throw error;
    }
  };

  get = async (packagingId: string) => {
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

      return data;
    } catch (error) {
      console.log("error getting packaging", error);
      throw error;
    }
  };

  getByUserId = async (userId: string) => {
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
    } catch (error) {
      console.log("error getting packaging by user", error);
      throw error;
    }
  };

  update = async (packagingId: string, data: Record<string, unknown>) => {
    try {
      await this.db
        .collection(this.collection)
        .doc(packagingId)
        .set(data, { merge: true });
      return { id: packagingId, ...data };
    } catch (error) {
      console.log("error updating packaging", error);
      throw error;
    }
  };
}

export default PackagingRepository;
