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
                    .where("createdBy", "==", userId)
                    // Active batch only — archived topics must never appear in the list
                    .where("archived", "==", false);
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
        // Bounded read for KMeans clustering — projects to title + embedding only and
        // caps at 200 docs at the query level so we never pull every embedding array.
        this.getTopicsForClustering = async (userId) => {
            const snapshot = await this.db
                .collection(this.collection)
                .where("createdBy", "==", userId)
                .where("archived", "==", false)
                .limit(200)
                .select("title", "embedding")
                .get();
            return snapshot.docs.map((doc) => doc.data());
        };
        this.getScripts = async (userId) => {
            try {
                const snapshot = await this.db
                    .collection(this.script_collection)
                    .where("createdBy", "==", userId)
                    .orderBy("createdAt", "desc")
                    .get();
                return snapshot.docs.map((doc) => {
                    const data = doc.data();
                    data.id = doc.id;
                    data.createdAt = data.createdAt?.toDate();
                    return data;
                });
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
            const updatedDataList = (dataList ?? []).map((data) => {
                const topic = data;
                // Topics convention: doc id = the UUID generated in formatGeneratedTitle.
                // Fall back to a Firestore auto-id only if no id was supplied.
                const docId = typeof topic.id === "string" && topic.id
                    ? topic.id
                    : collectionRef.doc().id;
                const dataWithId = { ...topic, id: docId };
                batch.set(collectionRef.doc(docId), dataWithId);
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
        // Active batch for regenerate/export — excludes embeddings (not needed here).
        this.getActiveBatch = async (userId) => {
            const snapshot = await this.db
                .collection(this.collection)
                .where("createdBy", "==", userId)
                .where("archived", "==", false)
                .select("title", "createdAt", "videoProjectId")
                .get();
            return snapshot.docs.map((doc) => {
                const data = doc.data();
                data.id = doc.id;
                return data;
            });
        };
        this.archiveUserTopics = async (userId, excludeBatchId) => {
            const snapshot = await this.db
                .collection(this.collection)
                .where("createdBy", "==", userId)
                .where("archived", "==", false)
                .select("batchId")
                .get();
            const toArchive = snapshot.docs.filter((doc) => !excludeBatchId || doc.data().batchId !== excludeBatchId);
            if (toArchive.length === 0)
                return;
            // Firestore caps a batch at 500 ops — chunk so large batches never throw.
            const CHUNK_SIZE = 450;
            for (let i = 0; i < toArchive.length; i += CHUNK_SIZE) {
                const batch = db.batch();
                toArchive.slice(i, i + CHUNK_SIZE).forEach((doc) => {
                    batch.update(doc.ref, {
                        archived: true,
                        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
                    });
                });
                await batch.commit();
            }
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
