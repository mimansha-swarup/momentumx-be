import { Firestore } from "firebase-admin/firestore";
import { COLLECTIONS } from "../constants/collection.js";
import { db, firebase } from "../config/firebase.js";
import { IPackagingItemStatuses, PackagingItemStatus, StaleReason } from "../types/routes/video-project.js";

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

  findByVideoProject = async (videoProjectId: string): Promise<Record<string, unknown> | null> => {
    try {
      const snapshot = await this.db
        .collection(this.collection)
        .where("videoProjectId", "==", videoProjectId)
        .limit(1)
        .get();

      if (snapshot.empty) return null;

      const doc = snapshot.docs[0];
      return { ...doc.data(), id: doc.id };
    } catch (error) {
      console.log("error finding packaging by video project", error);
      throw error;
    }
  };

  markStale = async (packagingId: string, reason: StaleReason): Promise<void> => {
    try {
      const doc = await this.db.collection(this.collection).doc(packagingId).get();
      if (!doc.exists) return;

      const data = doc.data();
      const currentStatuses = (data?.itemStatuses ?? {}) as IPackagingItemStatuses;

      const updatedStatuses: Record<string, PackagingItemStatus> = {};
      for (const key of ["title", "description", "thumbnail", "shorts"] as const) {
        const current = currentStatuses[key] ?? "not_started";
        updatedStatuses[key] = current === "completed" ? "stale" : current;
      }

      await this.db.collection(this.collection).doc(packagingId).update({
        itemStatuses: updatedStatuses,
        isStale: true,
        staleReason: reason,
        staleSince: firebase.firestore.FieldValue.serverTimestamp(),
      });
    } catch (error) {
      console.log("error marking packaging stale", error);
      throw error;
    }
  };
}

export default PackagingRepository;
