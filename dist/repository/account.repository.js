import { CHANNEL_CONTEXT_DOC, } from "../constants/collection.js";
import { db, firebase } from "../config/firebase.js";
class AccountRepository {
    constructor() {
        /**
         * One account by id. Read once per request by `accountMiddleware` (Phase 05) to
         * check membership — the id came from a client header, so nothing about it is
         * trusted until this read confirms the caller is in `memberUids`.
         */
        this.findById = async (accountId) => {
            if (!accountId)
                return null;
            const doc = await this.db.collection(this.collection).doc(accountId).get();
            if (!doc.exists)
                return null;
            return { ...doc.data(), id: doc.id };
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
        this.findByMember = async (uid) => {
            const snap = await this.db
                .collection(this.collection)
                .where("memberUids", "array-contains", uid)
                .get();
            return snap.docs.map((doc) => ({ ...doc.data(), id: doc.id }));
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
        this.createWithContext = async (account, context) => {
            const userRef = this.db.collection("users" /* COLLECTIONS.USERS */).doc(account.ownerUids[0]);
            return this.db.runTransaction(async (txn) => {
                const claimed = (await txn.get(userRef)).get("lastActiveAccountId");
                if (typeof claimed === "string" && claimed)
                    return claimed;
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
        this.createAdditional = async (account, context) => {
            const userRef = this.db.collection("users" /* COLLECTIONS.USERS */).doc(account.ownerUids[0]);
            return this.db.runTransaction(async (txn) => {
                this.writeAccount(txn, account, context, userRef);
                return account.id;
            });
        };
        /** The one place an account document and its context are written together. */
        this.writeAccount = (txn, account, context, userRef) => {
            const accountRef = this.db.collection(this.collection).doc(account.id);
            const now = firebase.firestore.FieldValue.serverTimestamp();
            txn.set(accountRef, { ...account, createdAt: now, updatedAt: now });
            txn.set(accountRef.collection("context" /* SUBCOLLECTIONS.CONTEXT */).doc(CHANNEL_CONTEXT_DOC), context);
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
        this.getContext = async (accountId) => {
            const doc = await this.db
                .collection(this.collection)
                .doc(accountId)
                .collection("context" /* SUBCOLLECTIONS.CONTEXT */)
                .doc(CHANNEL_CONTEXT_DOC)
                .get();
            return doc.exists ? doc.data() : null;
        };
        /**
         * Merge into the channel context. The channel now OWNS these fields — they are
         * not a copy of anything on the user record.
         */
        this.writeContext = async (accountId, patch) => {
            await this.db
                .collection(this.collection)
                .doc(accountId)
                .collection("context" /* SUBCOLLECTIONS.CONTEXT */)
                .doc(CHANNEL_CONTEXT_DOC)
                .set(patch, { merge: true });
        };
        this.update = async (accountId, patch) => {
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
        this.softDelete = async (accountId) => {
            await this.update(accountId, {
                deletedAt: firebase.firestore.FieldValue.serverTimestamp(),
            });
        };
        this.db = db;
        this.collection = "accounts" /* COLLECTIONS.ACCOUNTS */;
    }
}
export default AccountRepository;
