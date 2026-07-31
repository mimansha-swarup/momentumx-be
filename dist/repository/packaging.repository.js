import { db, firebase } from "../config/firebase.js";
class PackagingRepository {
    constructor() {
        this.save = async (data) => {
            try {
                const docRef = this.db.collection(this.collection).doc();
                const dataWithId = { ...data, id: docRef.id };
                await docRef.set(dataWithId);
                return dataWithId;
            }
            catch (error) {
                throw error;
            }
        };
        this.get = async (packagingId) => {
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
                return data ?? null;
            }
            catch (error) {
                throw error;
            }
        };
        this.getByUserId = async (userId) => {
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
            }
            catch (error) {
                throw error;
            }
        };
        this.update = async (packagingId, data) => {
            try {
                await this.db
                    .collection(this.collection)
                    .doc(packagingId)
                    .update(data);
                return { id: packagingId, ...data };
            }
            catch (error) {
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
        this.upsertGeneratedItem = async (videoProjectId, userId, field, item, canonical) => {
            const existing = await this.findByVideoProject(videoProjectId);
            const ref = this.db
                .collection(this.collection)
                .doc(existing?.id ?? videoProjectId);
            return this.db.runTransaction(async (txn) => {
                const snap = await txn.get(ref);
                const statuses = {
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
                }
                else {
                    txn.update(ref, {
                        [field]: canonical,
                        [`itemStatuses.${item}`]: "completed",
                        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
                    });
                }
                const allDone = ["title", "description", "thumbnail", "shorts"].every((k) => statuses[k] === "completed");
                return { packagingId: ref.id, created: !snap.exists, allDone };
            });
        };
        this.findByVideoProject = async (videoProjectId) => {
            try {
                const snapshot = await this.db
                    .collection(this.collection)
                    .where("videoProjectId", "==", videoProjectId)
                    .limit(1)
                    .get();
                if (snapshot.empty)
                    return null;
                const doc = snapshot.docs[0];
                return { ...doc.data(), id: doc.id };
            }
            catch (error) {
                throw error;
            }
        };
        this.markStale = async (packagingId, reason) => {
            try {
                const doc = await this.db.collection(this.collection).doc(packagingId).get();
                if (!doc.exists)
                    return;
                const data = doc.data();
                const currentStatuses = (data?.itemStatuses ?? {});
                const updatedStatuses = {};
                for (const key of ["title", "description", "thumbnail", "shorts"]) {
                    const current = currentStatuses[key] ?? "not_started";
                    updatedStatuses[key] = current === "completed" ? "stale" : current;
                }
                await this.db.collection(this.collection).doc(packagingId).update({
                    itemStatuses: updatedStatuses,
                    isStale: true,
                    staleReason: reason,
                    staleSince: firebase.firestore.FieldValue.serverTimestamp(),
                });
            }
            catch (error) {
                throw error;
            }
        };
        this.db = db;
        this.collection = "packaging" /* COLLECTIONS.PACKAGING */;
    }
}
export default PackagingRepository;
