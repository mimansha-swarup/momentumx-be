import { DocumentReference, Firestore, Transaction } from "firebase-admin/firestore";
import {
  CHANNEL_CONTEXT_DOC,
  COLLECTIONS,
  SUBCOLLECTIONS,
} from "../constants/collection.js";
import { db, firebase } from "../config/firebase.js";
import { isDocumentId } from "../utlils/firestore-id.js";
import { NotFound } from "../utlils/errors.js";
import { IAccount, IChannelContext } from "../types/routes/account.js";

class AccountRepository {
  private collection: `${COLLECTIONS}`;
  private db: Firestore;

  constructor() {
    this.db = db;
    this.collection = COLLECTIONS.ACCOUNTS;
  }

  /**
   * One account by id. Read once per request by `accountMiddleware` (Phase 05) to
   * check membership — the id came from a client header, so nothing about it is
   * trusted until this read confirms the caller is in `memberUids`.
   */
  findById = async (accountId: string): Promise<IAccount | null> => {
    // `isDocumentId`, not just a truthiness check — and this is the repository
    // its own docstring is written about. The guard was added to content,
    // hooks, packaging and video-project and skipped here, which left the
    // account routes exposed to exactly the two failures it describes:
    // `/v1/accounts/a%2Fb` threw a bare Error out of `.doc()` (a 500 where 404
    // is honest), and `/v1/accounts/<other-id>%2Fcontext%2Fchannel` RESOLVED —
    // reading another channel's context document, refused only because that
    // document has no `memberUids`. `accountMiddleware` validates the HEADER;
    // `req.params.id` reaches here untouched.
    if (!isDocumentId(accountId)) return null;
    const doc = await this.db.collection(this.collection).doc(accountId).get();
    if (!doc.exists) return null;
    return { ...(doc.data() as IAccount), id: doc.id };
  };

  /**
   * The channels this user can see.
   *
   * `array-contains` on `memberUids`, because Firestore cannot query inside the
   * `members` map — which is the whole reason that array exists alongside it.
   * A query may carry only ONE `array-contains`, so ownership is a separate
   * field rather than a second condition here.
   *
   * `id` comes from the DOCUMENT, exactly as `findById` does it. Returning bare
   * `doc.data()` made the id depend on a stored field that a restore or a
   * hand-written document can be missing, and a caller reading `account.id` then
   * got `undefined` — which resolves to "channel not found" on every request that
   * user makes, with no path back, because a membership was found so nothing
   * re-mints. `account.service.ts` carried a guard for this; the middleware did
   * not.
   */
  findByMember = async (uid: string): Promise<IAccount[]> => {
    const snap = await this.db
      .collection(this.collection)
      .where("memberUids", "array-contains", uid)
      .get();
    return snap.docs.map((doc) => ({ ...(doc.data() as IAccount), id: doc.id }));
  };

  /**
   * Claim this user's one account: writes the account, its channel context and
   * the user's pointer together, and returns the id that WON.
   *
   * A transaction, not a batch, and the pointer read is why. `ensureDefaultAccount`
   * is read-then-create, so two concurrent first-requests for a fresh user both
   * see "no account" and would each mint a different UUID. That splits one user's
   * records across two accounts — invisible until Phase 06 switches reads, when
   * half their content disappears. Re-reading the pointer inside the transaction
   * makes the loser write nothing and adopt the winner's id.
   *
   * The context goes in a SUBCOLLECTION, not on the account document. The account
   * doc is read on every authenticated request from Phase 05; `websiteContent` is
   * an uncapped page scrape. Co-located, a large scrape makes *membership writes*
   * fail against the 1 MiB limit — and the error would read as "can't add a
   * member", pointing nowhere near a website.
   */
  createWithContext = async (
    account: Omit<IAccount, "createdAt" | "updatedAt">,
    context: IChannelContext
  ): Promise<string> => {
    const userRef = this.db.collection(COLLECTIONS.USERS).doc(account.ownerUids[0]);

    return this.db.runTransaction(async (txn) => {
      const claimed = (await txn.get(userRef)).get("lastActiveAccountId");
      if (typeof claimed === "string" && claimed) return claimed;

      this.writeAccount(txn, account, context, userRef);
      return account.id;
    });
  };

  /**
   * Create an ADDITIONAL channel (Phase 06a). Always writes; never adopts.
   *
   * Deliberately a separate method rather than a flag on `createWithContext`. The
   * two differ in exactly one respect and it is the one that matters: the
   * bootstrap is idempotent, because two concurrent first-requests for a fresh
   * user must converge on one account. "Create a second channel" must not — a
   * user pressing the button twice wants two channels, and adopting the pointer
   * would silently hand back the one they are already in.
   */
  createAdditional = async (
    account: Omit<IAccount, "createdAt" | "updatedAt">,
    context: IChannelContext
  ): Promise<string> => {
    const userRef = this.db.collection(COLLECTIONS.USERS).doc(account.ownerUids[0]);

    return this.db.runTransaction(async (txn) => {
      this.writeAccount(txn, account, context, userRef);
      return account.id;
    });
  };

  /** The one place an account document and its context are written together. */
  private writeAccount = (
    txn: Transaction,
    account: Omit<IAccount, "createdAt" | "updatedAt">,
    context: IChannelContext,
    userRef: DocumentReference
  ): void => {
    const accountRef = this.db.collection(this.collection).doc(account.id);
    const now = firebase.firestore.FieldValue.serverTimestamp();

    txn.set(accountRef, { ...account, createdAt: now, updatedAt: now });
    txn.set(accountRef.collection(SUBCOLLECTIONS.CONTEXT).doc(CHANNEL_CONTEXT_DOC), context);
    // Creating a channel makes it the active one. Without this the client would
    // have to follow every create with an activate, and a failure between the two
    // leaves a channel the switcher shows but the API never acts in.
    txn.set(userRef, { lastActiveAccountId: account.id }, { merge: true });
  };

  /**
   * The channel half — niche, audience, competitors, the website scrape.
   *
   * Deliberately a SECOND method rather than part of `findById`. That one returns
   * the account document (membership, roles, billing owner) and runs on every
   * authenticated request; this one runs only when generating. They are separate
   * because collapsing them is how an uncapped `websiteContent` scrape ends up on
   * the document that every request reads, and then a *membership* write starts
   * failing against the 1 MiB limit with an error that points nowhere near a
   * website.
   */
  getContext = async (accountId: string): Promise<IChannelContext | null> => {
    if (!isDocumentId(accountId)) return null;
    const doc = await this.db
      .collection(this.collection)
      .doc(accountId)
      .collection(SUBCOLLECTIONS.CONTEXT)
      .doc(CHANNEL_CONTEXT_DOC)
      .get();
    return doc.exists ? (doc.data() as IChannelContext) : null;
  };

  /**
   * Merge into the channel context. The channel now OWNS these fields — they are
   * not a copy of anything on the user record.
   */
  writeContext = async (
    accountId: string,
    patch: Record<string, unknown>
  ): Promise<void> => {
    if (!isDocumentId(accountId)) throw NotFound("Channel not found");
    await this.db
      .collection(this.collection)
      .doc(accountId)
      .collection(SUBCOLLECTIONS.CONTEXT)
      .doc(CHANNEL_CONTEXT_DOC)
      .set(patch, { merge: true });
  };

  update = async (accountId: string, patch: Record<string, unknown>): Promise<void> => {
    if (!isDocumentId(accountId)) throw NotFound("Channel not found");
    await this.db
      .collection(this.collection)
      .doc(accountId)
      .update({ ...patch, updatedAt: firebase.firestore.FieldValue.serverTimestamp() });
  };

  /**
   * Tombstone, never a hard delete.
   *
   * 410 Gone and 404 Not Found are different answers to a stale bookmark or a
   * shared link, and only a surviving document can tell them apart. Phase 05's
   * middleware reads `deletedAt` to make that distinction and to clear the
   * pointer, so hard-deleting here would turn "this channel was deleted" into
   * "this id never existed" for every client holding it.
   */
  /**
   * Tombstone — but never the caller's last live channel.
   *
   * The guard used to live in the service as a read, a check, and then a write:
   * two concurrent `DELETE`s for a user with exactly two channels both read
   * `live.length === 2`, both passed, and both tombstoned. That leaves zero
   * channels, which is precisely what the guard exists to prevent —
   * `ensureDefaultAccount` then mints a fresh empty one on the next request, and
   * every document still carrying an old `accountId` is present, billable and
   * unreachable. Counting and writing in one transaction is the only version of
   * this check that holds.
   *
   * Returns false when it refused, so the caller can answer 400.
   */
  softDeleteUnlessLast = async (accountId: string, userId: string): Promise<boolean> =>
    this.db.runTransaction(async (txn) => {
      const snap = await txn.get(
        this.db.collection(this.collection).where("memberUids", "array-contains", userId)
      );
      const live = snap.docs.filter((doc) => !(doc.data() as IAccount).deletedAt);
      if (live.length <= 1) return false;

      const now = firebase.firestore.FieldValue.serverTimestamp();
      txn.update(this.db.collection(this.collection).doc(accountId), {
        deletedAt: now,
        updatedAt: now,
      });
      return true;
    });

  /**
   * The six tenancy collections. Every one of them carries `accountId`, which is
   * what makes this a query rather than a graph walk from the account document.
   */
  private static readonly PURGE_COLLECTIONS: COLLECTIONS[] = [
    COLLECTIONS.IDEAS,
    COLLECTIONS.SCRIPTS,
    COLLECTIONS.HOOKS,
    COLLECTIONS.PACKAGING,
    COLLECTIONS.VIDEO_PROJECTS,
    COLLECTIONS.EVENTS,
  ];

  /**
   * Delete a deleted channel's content.
   *
   * **Firestore does not cascade.** Tombstoning `accounts/{id}` leaves every
   * idea, script, hook batch, packaging document, video project and event
   * exactly where it was — present and billable, and unreachable only because
   * every query filters `accountId`. Phase 05 spells this out: "there is no
   * cascade, so account deletion has to enumerate and delete, or mark and
   * sweep". The endpoint shipped in Phase 06a doing neither.
   *
   * `accounts/{id}/context/channel` goes too, and it is the one that matters
   * most for a deletion request: it holds the niche, the competitor list and the
   * scraped website text. A subcollection is not removed with its parent either.
   * `usage/**` has no documents until Phase 08, so it is not swept here — add it
   * with the code that starts writing it.
   *
   * ponytail: capped PER COLLECTION and run inline. The first version shared one
   * counter across the whole loop, so a channel with 5,000+ ideas exhausted the
   * budget and `scripts`, `hooks`, `packaging`, `videoProjects` and `events`
   * were never queried at all — five whole collections skipped, chosen by array
   * order, silently. A per-collection cap cannot starve a sibling.
   *
   * Returns a report rather than a number so the caller can say what was left.
   * Phase 10's sweep is where an unbounded, resumable job belongs.
   */
  purgeAccountData = async (
    accountId: string,
    capPerCollection = 2000
  ): Promise<{ deleted: number; incomplete: string[] }> => {
    const PAGE = 450; // Firestore caps a batch at 500 writes.
    let deleted = 0;
    const incomplete: string[] = [];

    // FIRST, not last. The context holds the niche, the competitor list and the
    // uncapped website scrape — the data a deletion request is actually about.
    // Deleting it after the content loop meant that a timeout or a Firestore
    // error part-way through left precisely that document behind, and the
    // tombstone makes the operation unrepeatable through the API.
    await this.db
      .collection(this.collection)
      .doc(accountId)
      .collection(SUBCOLLECTIONS.CONTEXT)
      .doc(CHANNEL_CONTEXT_DOC)
      .delete();

    for (const collection of AccountRepository.PURGE_COLLECTIONS) {
      let fromThis = 0;

      while (fromThis < capPerCollection) {
        const snap = await this.db
          .collection(collection)
          .where("accountId", "==", accountId)
          .limit(PAGE)
          .get();
        if (snap.empty) break;

        const batch = this.db.batch();
        snap.docs.forEach((doc) => batch.delete(doc.ref));
        await batch.commit();
        fromThis += snap.size;
        deleted += snap.size;

        // A short page is the last page. Re-querying would cost one empty read
        // per collection for nothing.
        if (snap.size < PAGE) break;
      }

      // Hit the cap on a full page, so there is very likely more behind it.
      if (fromThis >= capPerCollection) incomplete.push(collection);
    }

    return { deleted, incomplete };
  };
}

export default AccountRepository;
