import { Firestore } from "firebase-admin/firestore";
import { COLLECTIONS } from "../constants/collection.js";
import { db, firebase } from "../config/firebase.js";
import { IPackagingItemStatuses, PackagingItemStatus, StaleReason } from "../types/routes/video-project.js";
import { IPackaging } from "../types/routes/packaging.js";

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
      throw error;
    }
  };

  get = async (packagingId: string): Promise<IPackaging | null> => {
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

      return (data as IPackaging) ?? null;
    } catch (error) {
      throw error;
    }
  };

  getByUserId = async (userId: string): Promise<IPackaging[]> => {
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
        } as IPackaging;
      });
    } catch (error) {
      throw error;
    }
  };

  update = async (packagingId: string, data: Record<string, unknown>) => {
    try {
      await this.db
        .collection(this.collection)
        .doc(packagingId)
        .update(data);
      return { id: packagingId, ...data };
    } catch (error) {
      throw error;
    }
  };

  // Atomic "generation writes its item to the doc" for the persist-on-generate
  // flow. Keyed on a DETERMINISTIC id (= videoProjectId) so two first-generations
  // racing (round 1 title+shorts) converge on ONE doc instead of creating two
  // auto-id docs; legacy/door docs (auto-id) are located by query and updated in
  // place. The transaction makes the itemStatuses read-modify-write and the
  // "all four done?" check see a consistent snapshot, so concurrent final writes
  // can't both skip completion. Returns whether it created the doc and whether
  // the whole set is now complete (so the service can drive the pipeline step).
  upsertGeneratedItem = async (
    videoProjectId: string,
    userId: string,
    field: string,
    item: string,
    canonical: unknown
  ): Promise<{ packagingId: string; created: boolean; statuses: Record<string, string> }> => {
    const existing = await this.findByVideoProject(videoProjectId);
    const ref = this.db
      .collection(this.collection)
      .doc(existing?.id ?? videoProjectId);

    return this.db.runTransaction(async (txn) => {
      const snap = await txn.get(ref);
      const statuses: Record<string, string> = {
        title: "not_started",
        description: "not_started",
        thumbnail: "not_started",
        shorts: "not_started",
        ...(snap.exists ? (snap.data()?.itemStatuses ?? {}) : {}),
        [item]: "completed",
      };

      if (!snap.exists) {
        txn.set(ref, {
          id: ref.id,
          createdBy: userId,
          videoProjectId,
          titles: [],
          description: "",
          thumbnail: [],
          shorts: { segments: [], totalDuration: "" },
          selectedTitleIndex: null,
          selectedThumbnailIndex: 0,
          isStale: false,
          staleReason: null,
          staleSince: null,
          [field]: canonical,
          itemStatuses: statuses,
          createdAt: firebase.firestore.FieldValue.serverTimestamp(),
        });
      } else {
        txn.update(ref, {
          [field]: canonical,
          [`itemStatuses.${item}`]: "completed",
          updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
        });
      }

      // Return the consistent in-transaction status snapshot; the service decides
      // step completion (packaging = its 3 items; title completes on select).
      return { packagingId: ref.id, created: !snap.exists, statuses };
    });
  };

  findByVideoProject = async (videoProjectId: string): Promise<IPackaging | null> => {
    try {
      const snapshot = await this.db
        .collection(this.collection)
        .where("videoProjectId", "==", videoProjectId)
        .limit(1)
        .get();

      if (snapshot.empty) return null;

      const doc = snapshot.docs[0];
      return { ...doc.data(), id: doc.id } as IPackaging;
    } catch (error) {
      throw error;
    }
  };

  // Inverse of markStale, for the "Keep as-is" path: the creator accepted the
  // content as-is, so the doc must stop reporting stale or every card keeps an
  // "Outdated" chip under a banner they already dismissed.
  clearStale = async (packagingId: string): Promise<void> => {
    const doc = await this.db.collection(this.collection).doc(packagingId).get();
    if (!doc.exists) return;

    const currentStatuses = (doc.data()?.itemStatuses ?? {}) as IPackagingItemStatuses;
    const updatedStatuses: Record<string, PackagingItemStatus> = {};
    for (const key of ["title", "description", "thumbnail", "shorts"] as const) {
      const current = currentStatuses[key] ?? "not_started";
      updatedStatuses[key] = current === "stale" ? "completed" : current;
    }

    await this.db.collection(this.collection).doc(packagingId).update({
      itemStatuses: updatedStatuses,
      isStale: false,
      staleReason: null,
      staleSince: null,
    });
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
      throw error;
    }
  };
}

export default PackagingRepository;
