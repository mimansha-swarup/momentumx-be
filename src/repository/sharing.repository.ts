import { memberRole } from "../utlils/account-member.js";
import { STEP_LOCK_MS } from "../constants/pipeline.js";
import { COLLECTIONS, SUBCOLLECTIONS } from "../constants/collection.js";
import { randomBytes } from "node:crypto";
import { FieldPath, Timestamp, Transaction, DocumentReference } from "firebase-admin/firestore";
import { db, firebase } from "../config/firebase.js";
import { IAccount, AccountRole } from "../types/routes/account.js";
import { AccountForbidden, BadRequest, HttpError, NotFound, RoleForbidden, Conflict } from "../utlils/errors.js";
import { isDocumentId } from "../utlils/firestore-id.js";

const INVITE_PAGE = 100;
const INVITE_LIFETIME_MS = 7 * 86400000;
const isTimestamp = (value: unknown): value is Timestamp => {
  const stamp = value as Timestamp | undefined;
  return typeof stamp?.toMillis === "function" && Number.isInteger(stamp?.seconds) && Number.isInteger(stamp?.nanoseconds)
    && stamp!.nanoseconds >= 0 && stamp!.nanoseconds < 1_000_000_000;
};

interface Invite {
  accountId: string; email: string; role: "editor" | "viewer";
  invitedBy: string; invitedByName: string; accountName: string;
  status: "pending" | "accepted" | "revoked";
  expiresAt: Timestamp; createdAt: Timestamp;
}

export default class SharingRepository {
  private accountRef(id: string) {
    if (!isDocumentId(id)) throw NotFound("Channel not found");
    return db.collection(COLLECTIONS.ACCOUNTS).doc(id);
  }
  private inviteRef(token: string) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw NotFound("Invite not found");
    return db.collection(COLLECTIONS.INVITES).doc(token);
  }
  private live(account: IAccount | undefined, uid?: string, owner = false): IAccount {
    if (!account || account.deletedAt || account.orphanedAt) throw AccountForbidden("Channel unavailable");
    if (uid && !account.memberUids?.includes(uid)) throw AccountForbidden();
    if (uid && owner && memberRole(account.members, uid) !== "owner") throw RoleForbidden();
    return account;
  }
  /** All membership edits read the document in their transaction and write these three fields together. */
  private writeMembers(tx: Transaction, ref: DocumentReference, account: IAccount) {
    const memberUids = Object.keys(account.members);
    const ownerUids = memberUids.filter(uid => account.members[uid].role === "owner");
    if (!ownerUids.length) throw BadRequest("Transfer ownership before leaving or removing the last owner");
    // Removing a payer nominates the lowest remaining owner; change() blocks this
    // while a channel generation is active. Log the payment responsibility change.
    if (!ownerUids.includes(account.billingOwnerUid)) {
      const next = [...ownerUids].sort()[0];
      console.warn(JSON.stringify({ event: "billing_owner_reassigned", from: account.billingOwnerUid, to: next }));
      account.billingOwnerUid = next;
    }
    tx.update(ref, { members: account.members, memberUids, ownerUids, billingOwnerUid: account.billingOwnerUid, updatedAt: firebase.firestore.FieldValue.serverTimestamp() });
  }
  /** Best-effort inbox cleanup; the per-UID marker is the authorization boundary. */
  private async revokePendingInvites(tx: Transaction, accountId: string, uid: string) {
    const profile = (await tx.get(db.collection(COLLECTIONS.USERS).doc(uid))).data();
    const email = typeof profile?.email === "string" ? profile.email.toLowerCase() : null;
    if (!email) return;
    const outstanding = await tx.get(
      db.collection(COLLECTIONS.INVITES)
        .where("accountId", "==", accountId)
        .where("email", "==", email)
        .where("status", "==", "pending")
    );
    for (const doc of (outstanding as { docs: { ref: DocumentReference }[] }).docs) {
      tx.update(doc.ref, { status: "revoked" });
    }
  }
  async members(accountId: string, uid: string) {
    const account = this.live((await this.accountRef(accountId).get()).data() as IAccount, uid, true);
    const members = await Promise.all(Object.entries(account.members).map(async ([uid, member]) => {
      const profile = (await db.collection(COLLECTIONS.USERS).doc(uid).get()).data();
      return { uid, role: member.role, displayName: profile?.displayName || profile?.name || uid, email: profile?.email || null };
    }));
    return { members, billingOwnerUid: account.billingOwnerUid };
  }
  async change(accountId: string, actor: string, target: string, role: AccountRole | null, transfer = false) {
    if (!isDocumentId(target)) throw BadRequest("Invalid member id");
    const ref = this.accountRef(accountId);
    await db.runTransaction(async tx => {
      const account = this.live((await tx.get(ref)).data() as IAccount, actor, !(actor === target && role === null));
      if (!Object.prototype.hasOwnProperty.call(account.members, target)) throw NotFound("Member not found");
      // All payer changes, including implicit reassignment, must wait for active work.
      // Read the payer before revoking invitations: Firestore requires reads before writes.
      const payerLosingOwnership =
        account.billingOwnerUid === target && (role === null || role !== "owner");
      const payerAtRisk = transfer
        ? account.billingOwnerUid === actor
          ? actor
          : null
        : payerLosingOwnership
          ? target
          : null;
      if (payerAtRisk) {
        const billing = (await tx.get(db.collection(COLLECTIONS.BILLING).doc(payerAtRisk))).data();
        // Same age rule as the billing repository: `startedAt` is server-written, and
        // legacy numeric values are still accepted.
        const lockAge = (startedAt: unknown): number =>
          Date.now() - (typeof startedAt === "number" ? startedAt : (startedAt as { toMillis?: () => number })?.toMillis?.() ?? 0);
        if (Object.entries(billing?.generationLocks ?? {}).some(([key, lock]) => key.startsWith(`${accountId}_`) && lockAge((lock as { startedAt: unknown }).startedAt) < STEP_LOCK_MS)) {
          throw Conflict("Wait for this channel's generation to finish before changing who pays for it");
        }
      }

      if (transfer) {
        if (actor === target) throw BadRequest("Choose another member");
        account.members[target].role = "owner";
        account.members[actor].role = "editor";
        if (account.billingOwnerUid === actor) account.billingOwnerUid = target;
      } else if (role) account.members[target].role = role;
      else delete account.members[target];

      // Transfer demotes the actor; other changes affect the target.
      await this.revokePendingInvites(tx, accountId, transfer ? actor : target);

      // UID is stable across email changes. Profile-email revocation above only cleans up
      // the inbox; this marker prevents old links from undoing a removal or demotion.
      tx.set(ref.collection(SUBCOLLECTIONS.MEMBERSHIP_CHANGES).doc(transfer ? actor : target), {
        changedAt: firebase.firestore.FieldValue.serverTimestamp(),
      });
      this.writeMembers(tx, ref, account);
    });
  }
  async create(accountId: string, uid: string, email: string, role: "editor" | "viewer") {
    const token = randomBytes(32).toString("base64url");
    const ref = this.accountRef(accountId);
    const invite = await db.runTransaction(async tx => {
      const account = this.live((await tx.get(ref)).data() as IAccount, uid, true);
      const profile = (await tx.get(db.collection(COLLECTIONS.USERS).doc(uid))).data();
      // One live invitation per address. Two pending invites for the same person
      // meant the WEAKER one could be accepted and the stronger one kept as a
      // spare — and an unbounded pile of them is a denial of service against the
      // invitee's inbox, which reads every one of them.
      const superseded = await tx.get(
        db.collection(COLLECTIONS.INVITES)
          .where("accountId", "==", accountId)
          .where("email", "==", email.toLowerCase())
          .where("status", "==", "pending")
      );
      const now = Timestamp.now();
      const invite: Invite = { accountId, email: email.toLowerCase(), role, invitedBy: uid,
        invitedByName: profile?.displayName || profile?.name || "A channel owner", accountName: account.displayName,
        // `createdAt` is a server sentinel; `expiresAt` deliberately is not,
        // because a sentinel cannot be used in arithmetic. The 7-day window is
        // therefore struck from this instance's clock — bounded, and the only
        // stored field here that is not server-truth.
        status: "pending", createdAt: firebase.firestore.FieldValue.serverTimestamp() as unknown as Timestamp,
        expiresAt: Timestamp.fromMillis(now.toMillis() + INVITE_LIFETIME_MS) };
      for (const doc of (superseded as { docs: { ref: DocumentReference }[] }).docs) {
        tx.update(doc.ref, { status: "revoked" });
      }
      tx.create(this.inviteRef(token), invite);
      return invite;
    });
    return { invite: this.serialize(token, invite), path: `/invite/${token}` };
  }
  private serialize(token: string, invite: Invite) {
    return { token, accountId: invite.accountId, accountName: invite.accountName, invitedByName: invite.invitedByName,
      email: invite.email, role: invite.role, status: invite.status, expiresAt: invite.expiresAt.toDate().toISOString() };
  }
  async preview(token: string) {
    const invite = (await this.inviteRef(token).get()).data() as Invite | undefined;
    if (!invite) throw NotFound("Invite not found");
    const account = (await this.accountRef(invite.accountId).get()).data() as IAccount | undefined;
    // The token must not disclose deleted/orphaned channel identity after a partial purge.
    if (!account || account.deletedAt || account.orphanedAt) throw NotFound("Invite not found");
    const [local, domain] = invite.email.split("@");
    return { accountName: account?.displayName || invite.accountName, invitedByName: invite.invitedByName,
      role: invite.role, emailMasked: `${local[0]}••••@${domain}`, expiresAt: invite.expiresAt.toDate().toISOString(),
      status: invite.status !== "pending" ? invite.status : invite.expiresAt.toMillis() <= Date.now() ? "expired" : "pending" };
  }
  async pending(email: string | undefined, verified: boolean | undefined) {
    if (!email || !verified) throw new HttpError("Verify your email to see invitations", 403, undefined, "invite_email_unverified");
    // Bounded, AND the expiry filter runs in the query, not after the limit. A
    // page of 100 expired invites followed by one live one used to come back
    // empty — the limit capped the query before the in-memory filter ever saw
    // the live row. Filtering expiry in the query means the cap applies to
    // live rows only, which is what "bounded inbox" is supposed to mean.
    const snap = await db.collection(COLLECTIONS.INVITES).where("email", "==", email.toLowerCase()).where("status", "==", "pending").where("expiresAt", ">", Timestamp.now()).limit(INVITE_PAGE).get();
    const pending = await Promise.all(snap.docs.map(async doc => {
      const invite = doc.data() as Invite;
      const account = (await this.accountRef(invite.accountId).get()).data() as IAccount | undefined;
      return account && !account.deletedAt && !account.orphanedAt ? this.serialize(doc.id, invite) : null;
    }));
    return pending.filter((invite): invite is NonNullable<typeof invite> => invite !== null);
  }
  async list(accountId: string, uid: string) {
    this.live((await this.accountRef(accountId).get()).data() as IAccount, uid, true);
    // Same fix as `pending`: expiry filtered in the query so the limit caps live
    // rows, not whatever happens to sort first among 100+ expired ones.
    const snap = await db.collection(COLLECTIONS.INVITES).where("accountId", "==", accountId).where("status", "==", "pending").where("expiresAt", ">", Timestamp.now()).limit(INVITE_PAGE).get();
    return snap.docs.map(doc => this.serialize(doc.id, doc.data() as Invite));
  }
  /** Spark-safe retention: a bounded document-id scan needs no expiry index or scheduler. */
  async pruneExpired(limit = 200, after?: string, dryRun = true) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 450) throw BadRequest("Invite cleanup limit must be 1 to 450");
    if (after) this.inviteRef(after); // Validate before using an operator-provided cursor.
    let query = db.collection(COLLECTIONS.INVITES).orderBy(FieldPath.documentId()).limit(limit);
    if (after) query = query.startAfter(after);
    const page = await query.get();
    const cutoff = Date.now();
    const isExpired = (data: FirebaseFirestore.DocumentData | undefined) =>
      isTimestamp(data?.expiresAt) && data.expiresAt.toMillis() <= cutoff;
    const candidates = page.docs.filter(doc => isExpired(doc.data()));
    let deleted = 0;
    if (!dryRun && candidates.length) {
      deleted = await db.runTransaction(async tx => {
        // Re-read all candidates before any write: an expiry extended since the scan survives.
        const current = await Promise.all(candidates.map(doc => tx.get(doc.ref)));
        const expired = current.filter(doc => isExpired(doc.data()));
        expired.forEach(doc => tx.delete(doc.ref));
        return expired.length;
      });
    }
    return {
      scanned: page.size, expired: candidates.length, deleted,
      nextCursor: page.size === limit ? page.docs[page.docs.length - 1].id : null,
    };
  }

  async revoke(accountId: string, uid: string, token: string) {
    await db.runTransaction(async tx => {
      this.live((await tx.get(this.accountRef(accountId))).data() as IAccount, uid, true);
      const ref = this.inviteRef(token);
      const invite = (await tx.get(ref)).data() as Invite | undefined;
      if (!invite || invite.accountId !== accountId) throw NotFound("Invite not found");
      if (invite.status !== "pending") throw BadRequest("Invite is no longer pending");
      tx.update(ref, { status: "revoked" });
    });
  }
  async accept(token: string, uid: string, email: string | undefined, verified: boolean | undefined) {
    if (!verified || !email) throw new HttpError("Verify your email before joining", 403, undefined, "invite_email_unverified");
    return db.runTransaction(async tx => {
      const inviteRef = this.inviteRef(token);
      const invite = (await tx.get(inviteRef)).data() as Invite | undefined;
      if (!invite) throw NotFound("Invite not found");
      if (invite.status !== "pending") throw new HttpError("Invite is no longer valid", 403, undefined, invite.status === "revoked" ? "invite_revoked" : "invite_used");
      // TTL only reclaims storage. Expiry is enforced here even on Spark, where TTL does not run.
      if (invite.expiresAt.toMillis() <= Date.now()) throw new HttpError("Invite expired", 403, undefined, "invite_expired");
      if (email.toLowerCase() !== invite.email) throw new HttpError("Use the invited email address", 403, undefined, "invite_email_mismatch");
      const ref = this.accountRef(invite.accountId);
      const account = (await tx.get(ref)).data() as IAccount | undefined;
      if (!account || account.deletedAt || account.orphanedAt) throw new HttpError("Invite is no longer valid", 403, undefined, "invite_revoked");
      const marker = await tx.get(ref.collection(SUBCOLLECTIONS.MEMBERSHIP_CHANGES).doc(uid));
      if (marker.exists) {
        const changed = marker.data()?.changedAt;
        // Compare full timestamp precision; a legitimate replacement can share a millisecond.
        const created = invite.createdAt;
        const newer = isTimestamp(created) && isTimestamp(changed)
          && (created.seconds > changed.seconds || (created.seconds === changed.seconds && created.nanoseconds > changed.nanoseconds));
        if (!newer) throw new HttpError("Ask the owner for a new invitation", 403, undefined, "invite_revoked");
      }
      /**
       * Take the HIGHER of the two roles, never the lower.
       *
       * Keeping an existing member's role unconditionally also blocked upgrades,
       * while still marking the invite accepted below — so an owner inviting a
       * viewer to become an editor got a cheerful 200, the token was burned, and
       * the viewer was still a viewer. A downgrade is still impossible, which is
       * what the original guard was protecting.
       */
      const RANK: Record<string, number> = { viewer: 0, editor: 1, owner: 2 };
      const existing = Object.prototype.hasOwnProperty.call(account.members, uid)
        ? (account.members[uid].role as string)
        : null;
      if (existing === null || RANK[invite.role] > (RANK[existing] ?? 0)) {
        Object.defineProperty(account.members, uid, {
          value: { role: invite.role, addedAt: firebase.firestore.FieldValue.serverTimestamp() },
          enumerable: true, writable: true, configurable: true,
        });
      }
      this.writeMembers(tx, ref, account);
      tx.update(inviteRef, { status: "accepted", acceptedBy: uid, acceptedAt: firebase.firestore.FieldValue.serverTimestamp() });
      tx.set(db.collection(COLLECTIONS.USERS).doc(uid), { lastActiveAccountId: invite.accountId }, { merge: true });
      return invite.accountId;
    });
  }
}
