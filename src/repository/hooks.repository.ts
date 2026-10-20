import type { CreditReservation } from "./billing.repository.js";
import { generationWrite } from "./generation-guard.js";
import { isDocumentId } from "../utlils/firestore-id.js";
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

  save = async (data: Omit<IHooksBatch, "id" | "createdAt">, charge?: CreditReservation | null): Promise<IHooksBatch> => {
    const docRef = this.db.collection(this.collection).doc();
    const doc: Record<string, unknown> = {
      ...data,
      id: docRef.id,
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    };
    if (charge) await generationWrite(charge, tx => tx.set(docRef, doc));
    else await docRef.set(doc);
    return doc as unknown as IHooksBatch;
  };

  findById = async (hooksId: string): Promise<IHooksBatch | null> => {
    // A route param reaching `.doc()` unchecked: `GET /v1/…/a%2Fb` decodes to
    // "a/b", which addresses a COLLECTION and throws a bare Error — rendered as
    // 500 "Something went wrong" where the honest answer is not-found.
    if (!isDocumentId(hooksId)) return null;
    const doc = await this.db.collection(this.collection).doc(hooksId).get();
    if (!doc.exists) return null;
    return doc.data() as IHooksBatch;
  };

  update = async (hooksId: string, data: Record<string, unknown>, charge?: CreditReservation | null): Promise<void> => {
    const ref = this.db.collection(this.collection).doc(hooksId);
    if (charge) await generationWrite(charge, tx => tx.update(ref, data));
    else await ref.update(data);
  };
}

export default HooksRepository;
