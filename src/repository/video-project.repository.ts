import { FieldPath, Firestore } from "firebase-admin/firestore";
import { COLLECTIONS } from "../constants/collection.js";
import { db, firebase } from "../config/firebase.js";
import { IVideoProject, OverallStatus } from "../types/routes/video-project.js";

interface ListOptions {
  status?: OverallStatus;
  limit: number;
  cursor?: string;
}

class VideoProjectRepository {
  private collection: `${COLLECTIONS}`;
  private db: Firestore;

  constructor() {
    this.db = db;
    this.collection = COLLECTIONS.VIDEO_PROJECTS;
  }

  create = async (data: Record<string, unknown>): Promise<IVideoProject> => {
    const docRef = this.db.collection(this.collection).doc();
    const dataWithId = { ...data, id: docRef.id };
    await docRef.set(dataWithId);
    return dataWithId as IVideoProject;
  };

  findById = async (projectId: string): Promise<IVideoProject | null> => {
    const doc = await this.db.collection(this.collection).doc(projectId).get();
    if (!doc.exists) return null;
    return doc.data() as IVideoProject;
  };

  list = async (
    userId: string,
    { status, limit, cursor }: ListOptions
  ): Promise<{ projects: IVideoProject[]; hasMore: boolean; nextCursor: string | null }> => {
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
        const err = new Error("Invalid cursor") as Error & { statusCode: number };
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

    const projects = resultDocs.map((doc) => doc.data() as IVideoProject);
    const nextCursor = hasMore ? resultDocs[resultDocs.length - 1].id : null;

    return { projects, hasMore, nextCursor };
  };

  update = async (
    projectId: string,
    data: Record<string, unknown>
  ): Promise<void> => {
    await this.db
      .collection(this.collection)
      .doc(projectId)
      .set(
        { ...data, lastUpdatedAt: firebase.firestore.FieldValue.serverTimestamp() },
        { merge: true }
      );
  };
}

export default VideoProjectRepository;
