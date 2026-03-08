import { FieldPath } from "firebase-admin/firestore";
import { db, firebase } from "../config/firebase.js";
class VideoProjectRepository {
    constructor() {
        this.create = async (data) => {
            const docRef = this.db.collection(this.collection).doc();
            const dataWithId = { ...data, id: docRef.id };
            await docRef.set(dataWithId);
            return dataWithId;
        };
        this.findById = async (projectId) => {
            const doc = await this.db.collection(this.collection).doc(projectId).get();
            if (!doc.exists)
                return null;
            return doc.data();
        };
        this.list = async (userId, { status, limit, cursor }) => {
            let query = this.db
                .collection(this.collection)
                .where("userId", "==", userId)
                .where("isDeleted", "==", false);
            if (status) {
                query = query.where("overallStatus", "==", status);
            }
            query = query
                .orderBy("lastUpdatedAt", "desc")
                .orderBy(FieldPath.documentId(), "desc");
            if (cursor) {
                const cursorDoc = await this.db.collection(this.collection).doc(cursor).get();
                if (!cursorDoc.exists) {
                    const err = new Error("Invalid cursor");
                    err.statusCode = 400;
                    throw err;
                }
                query = query.startAfter(cursorDoc);
            }
            // Fetch one extra to determine hasMore
            const snapshot = await query.limit(limit + 1).get();
            const docs = snapshot.docs;
            const hasMore = docs.length > limit;
            const resultDocs = hasMore ? docs.slice(0, limit) : docs;
            const projects = resultDocs.map((doc) => doc.data());
            const nextCursor = hasMore ? resultDocs[resultDocs.length - 1].id : null;
            return { projects, hasMore, nextCursor };
        };
        this.update = async (projectId, data) => {
            await this.db
                .collection(this.collection)
                .doc(projectId)
                .set({ ...data, lastUpdatedAt: firebase.firestore.FieldValue.serverTimestamp() }, { merge: true });
        };
        this.findByScriptId = async (scriptId, userId) => {
            const snap = await this.db.collection(this.collection)
                .where("scriptId", "==", scriptId)
                .where("userId", "==", userId)
                .where("isDeleted", "==", false)
                .limit(1)
                .get();
            if (snap.empty)
                return null;
            return snap.docs[0].data();
        };
        this.db = db;
        this.collection = "videoProjects" /* COLLECTIONS.VIDEO_PROJECTS */;
    }
}
export default VideoProjectRepository;
