import { Firestore } from "firebase-admin/firestore";
import {
  CHANNEL_CONTEXT_DOC,
  COLLECTIONS,
  SUBCOLLECTIONS,
} from "../constants/collection.js";
import { db, firebase } from "../config/firebase.js";
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
    if (!accountId) return null;
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
   */
  findByMember = async (uid: string): Promise<IAccount[]> => {
    const snap = await this.db
      .collection(this.collection)
      .where("memberUids", "array-contains", uid)
      .get();
    return snap.docs.map((doc) => doc.data() as IAccount);
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
    const accountRef = this.db.collection(this.collection).doc(account.id);

    return this.db.runTransaction(async (txn) => {
      const claimed = (await txn.get(userRef)).get("lastActiveAccountId");
      if (typeof claimed === "string" && claimed) return claimed;

      const now = firebase.firestore.FieldValue.serverTimestamp();
      txn.set(accountRef, { ...account, createdAt: now, updatedAt: now });
      txn.set(accountRef.collection(SUBCOLLECTIONS.CONTEXT).doc(CHANNEL_CONTEXT_DOC), context);
      txn.set(userRef, { lastActiveAccountId: account.id }, { merge: true });

      return account.id;
    });
  };
}

export default AccountRepository;
