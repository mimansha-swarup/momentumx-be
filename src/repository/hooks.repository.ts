import { Firestore } from "firebase-admin/firestore";
import { COLLECTIONS } from "../constants/collection.js";
import { db, firebase } from "../config/firebase.js";
import { IHooksBatch } from "../types/routes/hooks.js";

class HooksRepository {
  private collection: `${COLLECTIONS}`;
  private db: Firestore;

  constructor() {
    this.db = db;
    this.collection = COLLECTIONS.HOOKS;
  }

  save = async (data: Omit<IHooksBatch, "id" | "createdAt">): Promise<IHooksBatch> => {
    const docRef = this.db.collection(this.collection).doc();
    const doc: Record<string, unknown> = {
      ...data,
      id: docRef.id,
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    };
    await docRef.set(doc);
    return doc as unknown as IHooksBatch;
  };

  findById = async (hooksId: string): Promise<IHooksBatch | null> => {
    const doc = await this.db.collection(this.collection).doc(hooksId).get();
    if (!doc.exists) return null;
    return doc.data() as IHooksBatch;
  };

  update = async (hooksId: string, data: Record<string, unknown>): Promise<void> => {
    await this.db.collection(this.collection).doc(hooksId).set(data, { merge: true });
  };
}

export default HooksRepository;
