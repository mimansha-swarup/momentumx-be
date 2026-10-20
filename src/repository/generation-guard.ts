import { memberRole } from "../utlils/account-member.js";
import { Transaction } from "firebase-admin/firestore";
import { db } from "../config/firebase.js";
import { COLLECTIONS, SUBCOLLECTIONS } from "../constants/collection.js";
import { consumedCredits, type CreditReservation } from "./billing.repository.js";
import { AccountForbidden, Conflict, RoleForbidden } from "../utlils/errors.js";

/** Call before any writes, INSIDE the transaction that persists generation output. */
export const assertGeneration = async (tx: Transaction, charge?: CreditReservation | null) => {
  if (!charge) return;
  const account = (await tx.get(db.collection(COLLECTIONS.ACCOUNTS).doc(charge.accountId))).data();
  if (!account || account.deletedAt || account.orphanedAt || !memberRole(account.members, charge.actorUserId)) throw AccountForbidden();
  if (memberRole(account.members, charge.actorUserId) === "viewer") throw RoleForbidden();
  const resource = charge.projectId
    ? (await tx.get(db.collection(COLLECTIONS.VIDEO_PROJECTS).doc(charge.projectId))).data()
    : account;
  if (!resource || resource.isDeleted || (charge.projectId && resource.accountId !== charge.accountId)) throw AccountForbidden();
  if (resource.generationLocks?.[charge.kind]?.token !== charge.token) throw Conflict("This generation was superseded by a newer request");
  /**
   * The project lock alone is not enough: `BillingRepository.reserve`'s pruning
   * is payer-wide, not project-wide. An UNRELATED generation for the same payer,
   * reserved after this charge's lock has aged past STEP_LOCK_MS, sweeps this
   * charge's billing-doc receipt AND its billing-doc lock entry — but has no
   * reason to touch this project's document, so the check above still passes.
   * Without this, that write lands, unrecorded and uncharged.
   *
   * Mirrors the exact liveness test `settle` uses at billing.repository.ts's
   * success-path gate, so the two can never disagree about what "still live"
   * means: a debited charge needs its pending receipt; a free one needs its
   * usage receipt or to still own the billing lock.
   */
  const billing = (await tx.get(db.collection(COLLECTIONS.BILLING).doc(charge.ownerUid))).data();
  const ownsBillingLock = billing?.generationLocks?.[charge.lockKey]?.token === charge.token;
  const superseded = charge.debited
    ? !billing?.pendingCharges?.[charge.token]
    : !billing?.usageReceipts?.[charge.token] && !ownsBillingLock;
  if (superseded) throw Conflict("This generation was superseded by a newer request");
};

/** After assertGeneration, read accounting before any artifact writes; invoke the
 * returned writer in that transaction. A delivered receipt keeps subsequent
 * metadata writes fenced without charging twice.
 */
export const prepareGenerationDelivery = async (tx: Transaction, charge?: CreditReservation | null) => {
  if (!charge) return () => {};
  const ref = db.collection(COLLECTIONS.BILLING).doc(charge.ownerUid);
  const billing = (await tx.get(ref)).data();
  const receipt = charge.debited ? billing?.pendingCharges?.[charge.token] : billing?.usageReceipts?.[charge.token];
  const lock = billing?.generationLocks?.[charge.lockKey];
  if (receipt?.delivered || (lock?.token === charge.token && lock.delivered)) return () => {};
  const usageRef = db.collection(COLLECTIONS.ACCOUNTS).doc(charge.accountId).collection(SUBCOLLECTIONS.USAGE).doc(charge.periodStart);
  const usage = (await tx.get(usageRef)).data();
  const updates: Record<string, unknown> = {};
  if (charge.debited && billing?.periodStart === charge.periodStart) {
    updates.consumed = consumedCredits(consumedCredits(billing.consumed ?? 0) + charge.cost);
  }
  const receiptField = charge.debited ? "pendingCharges" : "usageReceipts";
  if (receipt) updates[`${receiptField}.${charge.token}.delivered`] = true;
  if (lock?.token === charge.token) updates[`generationLocks.${charge.lockKey}.delivered`] = true;
  return () => {
    tx.update(ref, updates);
    tx.set(usageRef, { credits: (usage?.credits ?? 0) + charge.cost, [charge.counter]: (usage?.[charge.counter] ?? 0) + 1 }, { merge: true });
  };
};

export const generationWrite = async (charge: CreditReservation, write: (tx: Transaction) => unknown, deliversOutput = false) => {
  await db.runTransaction(async tx => {
    await assertGeneration(tx, charge);
    const deliver = deliversOutput ? await prepareGenerationDelivery(tx, charge) : () => {};
    await write(tx);
    deliver();
  });
  if (deliversOutput) charge.outputPersisted = true;
};
