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
    return this.db.runTransaction(async (txn) => {
      // Phase 01 item 3. This lookup used to run OUTSIDE the transaction, which
      // defeated the point of having one: persist-on-generate fires four item
      // writes concurrently, and the document this call decided to write to could
      // be created by a sibling in the gap. Reading the query inside the
      // transaction puts the choice of document under the same consistency
      // guarantee as the write to it.
      const locate = this.db
        .collection(this.collection)
        .where("videoProjectId", "==", videoProjectId)
        .limit(1);
      const found = await txn.get(locate);

      // Deterministic id for a new document (id === videoProjectId), so two
      // concurrent first-generations converge on ONE doc instead of racing two
      // auto-id creates. Legacy/door docs may still carry an auto-id, which is
      // why the query above locates rather than assuming.
      const ref = found.empty
        ? this.db.collection(this.collection).doc(videoProjectId)
        : found.docs[0].ref;
      const snap = found.empty ? await txn.get(ref) : found.docs[0];
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
  // Phase 01 item 3. Both of these used to read `itemStatuses`, rebuild it in
  // memory and write the WHOLE map back. Any item that changed in the gap — a
  // regenerate completing mid-cascade — was reverted by the write, because the
  // map being written was computed from a snapshot that no longer matched.
  //
  // Two changes: the read and the write now share a transaction, and only the
  // keys that actually flip are written, as dotted paths. `upsertGeneratedItem`
  // already used dotted paths; these two just didn't follow the pattern. An item
  // this call doesn't touch is now untouched in the write, not rewritten to the
  // value it happened to have when we looked.
  private transitionItemStatuses = async (
    packagingId: string,
    from: PackagingItemStatus,
    to: PackagingItemStatus,
    docFields: Record<string, unknown>
  ): Promise<void> => {
    const ref = this.db.collection(this.collection).doc(packagingId);

    await this.db.runTransaction(async (txn) => {
      const doc = await txn.get(ref);
      if (!doc.exists) return;

      const currentStatuses = (doc.data()?.itemStatuses ?? {}) as IPackagingItemStatuses;
      const updates: Record<string, unknown> = { ...docFields };

      for (const key of ["title", "description", "thumbnail", "shorts"] as const) {
        if ((currentStatuses[key] ?? "not_started") === from) {
          updates[`itemStatuses.${key}`] = to;
        }
      }

      txn.update(ref, updates);
    });
  };

  // Inverse of markStale, for the "Keep as-is" path: the creator accepted the
  // content as-is, so the doc must stop reporting stale or every card keeps an
  // "Outdated" chip under a banner they already dismissed.
  clearStale = async (packagingId: string): Promise<void> => {
    await this.transitionItemStatuses(packagingId, "stale", "completed", {
      isStale: false,
      staleReason: null,
      staleSince: null,
    });
  };

  markStale = async (packagingId: string, reason: StaleReason): Promise<void> => {
    await this.transitionItemStatuses(packagingId, "completed", "stale", {
      isStale: true,
      staleReason: reason,
      staleSince: firebase.firestore.FieldValue.serverTimestamp(),
    });
  };
}

export default PackagingRepository;
