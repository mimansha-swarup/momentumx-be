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
                return data;
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
                    .set(data, { merge: true });
                return { id: packagingId, ...data };
            }
            catch (error) {
                throw error;
            }
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
