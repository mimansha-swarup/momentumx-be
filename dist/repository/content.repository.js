import { db, firebase } from "../config/firebase.js";
class ContentRepository {
    constructor() {
        this.getTopic = async (topicId) => {
            const doc = await this.db.collection(this.collection).doc(topicId).get();
            return doc.data();
        };
        this.getTopics = async ({ userId, limit = 8, cursor, filters, }) => {
            try {
                let query = this.db
                    .collection(this.collection)
                    .where("createdBy", "==", userId);
                // Optional filtering
                if (filters.hasOwnProperty("isScriptGenerated") &&
                    filters?.isScriptGenerated) {
                    query = query.where("isScriptGenerated", "==", filters.isScriptGenerated);
                }
                if (filters.searchText) {
                    // Prefix search using title
                    query = query.orderBy("title");
                    query = query
                        .startAt(filters.searchText)
                        .endAt(filters.searchText + "\uf8ff");
                }
                // Pagination
                else if (cursor?.createdAt && cursor?.docId) {
                    // Default ordering if no search
                    query = query
                        .orderBy("createdAt", "desc")
                        .orderBy(firebase.firestore.FieldPath.documentId(), "desc");
                    query = query.startAfter(firebase.firestore.Timestamp.fromDate(new Date(cursor.createdAt)), cursor.docId);
                }
                query = query.limit(limit);
                const snapshot = await query.get();
                return snapshot.docs.map((doc) => doc.data());
            }
            catch (error) {
                throw error;
            }
        };
        this.getAllTopics = async ({ userId = "" }) => {
            const query = this.db
                .collection(this.collection)
                .where("createdBy", "==", userId);
            const snapshot = await query.get();
            return snapshot.docs.map((doc) => doc.data());
        };
        this.getScripts = async (userId) => {
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
            }
            catch (error) {
                throw error;
            }
        };
        this.getScriptById = async (scriptId) => {
            const snapshot = await this.db
                .collection(this.script_collection)
                .doc(scriptId)
                .get();
            if (!snapshot.exists) {
                return null;
            }
            const data = snapshot.data();
            data.createdAt = data.createdAt?.toDate();
            return data;
        };
        this.batchSaveTopics = async (dataList) => {
            const batch = db.batch();
            const collectionRef = db.collection(this.collection);
            const updatedDataList = dataList?.map((data) => {
                const newDocRef = collectionRef.doc();
                const dataWithId = { ...data, id: newDocRef.id };
                batch.set(newDocRef, dataWithId);
                return dataWithId;
            });
            try {
                await batch.commit();
                return updatedDataList;
            }
            catch (err) {
                console.error("❌ Failed to batch create documents", err);
                throw err;
            }
        };
        this.getActiveBatch = async (userId) => {
            const allTopics = await this.getAllTopics({ userId });
            return (allTopics || []).filter((t) => t.archived !== true);
        };
        this.archiveUserTopics = async (userId, excludeBatchId) => {
            const allTopics = await this.getAllTopics({ userId });
            const toArchive = (allTopics || []).filter((t) => t.archived !== true &&
                t.id &&
                (!excludeBatchId || t.batchId !== excludeBatchId));
            if (toArchive.length === 0)
                return;
            const batch = db.batch();
            const collectionRef = db.collection(this.collection);
            toArchive.forEach((topic) => {
                batch.update(collectionRef.doc(topic.id), {
                    archived: true,
                    updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
                });
            });
            await batch.commit();
        };
        this.updateTopic = async (topicId, data) => {
            await this.db
                .collection(this.collection)
                .doc(topicId)
                .set(data, { merge: true });
        };
        this.editScript = async (scriptId, data) => {
            await this.db
                .collection(this.script_collection)
                .doc(scriptId)
                .set(data, { merge: true });
        };
        this.saveScript = async (scriptId, data) => {
            await this.db
                .collection(this.script_collection)
                .doc(scriptId)
                .set(data, { merge: true });
        };
        this.db = db;
        this.collection = "topics" /* COLLECTIONS.TOPICS */;
        this.script_collection = "scripts" /* COLLECTIONS.SCRIPTS */;
    }
}
export default ContentRepository;
