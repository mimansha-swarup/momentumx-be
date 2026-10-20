import type { CreditReservation } from "./billing.repository.js";
import { generationWrite } from "./generation-guard.js";
import { isDocumentId } from "../utlils/firestore-id.js";
import { Firestore, Transaction } from "firebase-admin/firestore";
import { AccountForbidden } from "../utlils/errors.js";
import { downstreamOf } from "../constants/pipeline.js";
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
    if (charge) await this.writeGenerated(charge, docRef.id, tx => tx.set(docRef, doc));
    else await docRef.set(doc);
    return doc as unknown as IHooksBatch;
  };

  /** Replacement selection and stale marks must commit with the paid batch.
   * Otherwise a metadata outage could expose new hooks under an old selection.
   */
  private writeGenerated = (charge: CreditReservation, hooksId: string, write: (tx: Transaction) => void) =>
    generationWrite(charge, async tx => {
      const projectRef = charge.projectId ? this.db.collection(COLLECTIONS.VIDEO_PROJECTS).doc(charge.projectId) : undefined;
      const project = projectRef ? (await tx.get(projectRef)).data() : undefined;
      const replacing = Boolean(project?.hooksId);
      const packagingRef = replacing && project?.packagingId ? this.db.collection(COLLECTIONS.PACKAGING).doc(project.packagingId) : undefined;
      const packaging = packagingRef ? (await tx.get(packagingRef)).data() : undefined;
      if (packaging && packaging.accountId !== charge.accountId) throw AccountForbidden();
      write(tx);
      if (projectRef) {
        const updates: Record<string, unknown> = { hooksId, selectedHookIndex: null, "pipeline.hooks.status": "in_progress", "pipeline.hooks.completedAt": null };
        if (replacing) {
          for (const step of downstreamOf("hooks")) {
            if (project?.pipeline?.[step] && project.pipeline[step].status !== "not_started") {
              updates[`pipeline.${step}.status`] = "stale";
              updates[`pipeline.${step}.staleReason`] = "hooks_regenerated";
            }
          }
        }
        updates.overallStatus = Object.keys(updates).some(key => key.endsWith(".staleReason")) || Object.entries(project?.pipeline ?? {}).some(([step, state]) => step !== "hooks" && (state as { status?: string }).status === "stale") ? "stale" : "in_progress";
        tx.update(projectRef, updates);
      }
      if (packagingRef && packaging) {
        const updates: Record<string, unknown> = { isStale: true, staleReason: "hooks_regenerated", staleSince: firebase.firestore.FieldValue.serverTimestamp() };
        for (const item of ["title", "description", "thumbnail", "shorts"]) {
          if (packaging.itemStatuses?.[item] === "completed") updates[`itemStatuses.${item}`] = "stale";
        }
        tx.update(packagingRef, updates);
      }
    }, true);

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
    if (charge) await this.writeGenerated(charge, hooksId, tx => tx.update(ref, data));
    else await ref.update(data);
  };
}

export default HooksRepository;
