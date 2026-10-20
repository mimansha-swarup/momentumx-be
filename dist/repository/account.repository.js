import { memberRole } from "../utlils/account-member.js";
import { CHANNEL_CONTEXT_DOC, } from "../constants/collection.js";
import { db, firebase } from "../config/firebase.js";
import { isDocumentId } from "../utlils/firestore-id.js";
import { BadRequest, AccountForbidden, Gone, NotFound, RoleForbidden } from "../utlils/errors.js";
class AccountRepository {
    constructor() {
        /**
         * One account by id. Read once per request by `accountMiddleware` (Phase 05) to
         * check membership — the id came from a client header, so nothing about it is
         * trusted until this read confirms the caller is in `memberUids`.
         */
        this.findById = async (accountId) => {
            // `isDocumentId`, not just a truthiness check — and this is the repository
            // its own docstring is written about. The guard was added to content,
            // hooks, packaging and video-project and skipped here, which left the
            // account routes exposed to exactly the two failures it describes:
            // `/v1/accounts/a%2Fb` threw a bare Error out of `.doc()` (a 500 where 404
            // is honest), and `/v1/accounts/<other-id>%2Fcontext%2Fchannel` RESOLVED —
            // reading another channel's context document, refused only because that
            // document has no `memberUids`. `accountMiddleware` validates the HEADER;
            // `req.params.id` reaches here untouched.
            if (!isDocumentId(accountId))
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
                if (typeof claimed === "string" && isDocumentId(claimed)) {
                    const existing = await txn.get(this.db.collection(this.collection).doc(claimed));
                    const data = existing.data();
                    if (data && !data.deletedAt && !data.orphanedAt && data.memberUids?.includes(account.ownerUids[0]))
                        return claimed;
                }
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
            if (!isDocumentId(accountId))
                return null;
            const doc = await this.db
                .collection(this.collection)
                .doc(accountId)
                .collection("context" /* SUBCOLLECTIONS.CONTEXT */)
                .doc(CHANNEL_CONTEXT_DOC)
                .get();
            return doc.exists ? doc.data() : null;
        };
        this.writeContext = async (accountId, patch, actorUserId) => {
            if (!isDocumentId(accountId))
                throw NotFound("Channel not found");
            const ref = this.db.collection(this.collection).doc(accountId);
            await this.db.runTransaction(async (txn) => {
                // Enrichment can finish after deletion or membership changes.
                this.assertContextWriter((await txn.get(ref)).data(), actorUserId);
                txn.set(ref.collection("context" /* SUBCOLLECTIONS.CONTEXT */).doc(CHANNEL_CONTEXT_DOC), patch, { merge: true });
            });
        };
        this.update = async (accountId, patch, actorUserId) => {
            if (!isDocumentId(accountId))
                throw NotFound("Channel not found");
            const ref = this.db.collection(this.collection).doc(accountId);
            await this.db.runTransaction(async (txn) => {
                this.assertContextWriter((await txn.get(ref)).data(), actorUserId);
                txn.update(ref, { ...patch, updatedAt: firebase.firestore.FieldValue.serverTimestamp() });
            });
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
        /**
         * Owner-only channel edits, with the owner check inside the writing transaction.
         *
         * The service checks ownership first, but that is a separate read: a demotion
         * committing in the gap let a now-non-owner's rename land. Same reasoning as
         * `softDeleteUnlessLast` below — authorization must share the transaction with
         * the write it authorizes.
         */
        this.updateIfOwner = async (accountId, userId, changes) => {
            if (!isDocumentId(accountId))
                throw NotFound("Channel not found");
            const ref = this.db.collection(this.collection).doc(accountId);
            await this.db.runTransaction(async (txn) => {
                const account = (await txn.get(ref)).data();
                if (!account)
                    throw AccountForbidden("Channel not found");
                if (!account.memberUids?.includes(userId))
                    throw AccountForbidden();
                if (account.deletedAt)
                    throw Gone();
                if (account.orphanedAt)
                    throw AccountForbidden("Channel needs ownership recovery; contact support");
                if (memberRole(account.members, userId) !== "owner")
                    throw RoleForbidden("Only the channel owner can do this");
                txn.update(ref, { ...changes, updatedAt: firebase.firestore.FieldValue.serverTimestamp() });
            });
        };
        this.softDeleteUnlessLast = async (accountId, userId) => this.db.runTransaction(async (txn) => {
            const snap = await txn.get(this.db.collection(this.collection).where("memberUids", "array-contains", userId));
            // Authorization must share the transaction with the tombstone. The service's
            // earlier owner check can race a demotion/removal before destructive purge.
            const target = snap.docs.find(doc => doc.id === accountId)?.data();
            if (!target || target.orphanedAt)
                throw AccountForbidden();
            if (target.deletedAt)
                throw Gone();
            if (memberRole(target.members, userId) !== "owner")
                throw RoleForbidden();
            const live = snap.docs.filter((doc) => {
                const account = doc.data();
                return !account.deletedAt && !account.orphanedAt;
            });
            if (live.length <= 1)
                return false;
            const now = firebase.firestore.FieldValue.serverTimestamp();
            txn.update(this.db.collection(this.collection).doc(accountId), {
                deletedAt: now,
                updatedAt: now,
            });
            return true;
        });
        /**
         * Purge only tombstoned channels, retaining the tombstone and telemetry.
         * Each collection has its own strict cap; repeated calls resume from remaining rows.
         * Context is deleted first. The dry run reads at most cap + 1 rows per collection.
         */
        this.purgeAccountData = async (accountId, capPerCollection = 2000, dryRun = false) => {
            if (!Number.isInteger(capPerCollection) || capPerCollection < 1 || capPerCollection > 2000) {
                throw BadRequest("Purge limit must be an integer from 1 to 2000 per collection");
            }
            const account = await this.findById(accountId);
            if (!account?.deletedAt)
                throw BadRequest("Only a tombstoned channel can be purged");
            const accountRef = this.db.collection(this.collection).doc(accountId);
            const contextRef = accountRef.collection("context" /* SUBCOLLECTIONS.CONTEXT */).doc(CHANNEL_CONTEXT_DOC);
            let deleted = 0;
            let matched = 0;
            const incomplete = [];
            const hasContext = (await contextRef.get()).exists;
            if (dryRun) {
                if (hasContext)
                    matched++;
            }
            else {
                // Context goes first, so a later batch failure cannot strand the private scrape.
                await contextRef.delete();
                if (hasContext)
                    deleted++;
            }
            const nestedPaths = ["usage" /* SUBCOLLECTIONS.USAGE */, "membershipChanges" /* SUBCOLLECTIONS.MEMBERSHIP_CHANGES */].map(name => `${this.collection}/${accountId}/${name}`);
            for (const collection of [...AccountRepository.PURGE_COLLECTIONS, ...nestedPaths]) {
                const query = nestedPaths.includes(collection)
                    ? this.db.collection(collection)
                    : this.db.collection(collection).where("accountId", "==", accountId);
                if (dryRun) {
                    const preview = await query.limit(capPerCollection + 1).get();
                    matched += Math.min(preview.size, capPerCollection);
                    if (preview.size > capPerCollection)
                        incomplete.push(collection);
                    continue;
                }
                let fromThis = 0;
                while (fromThis < capPerCollection) {
                    const pageSize = Math.min(450, capPerCollection - fromThis);
                    const snap = await query.limit(pageSize).get();
                    if (snap.empty)
                        break;
                    const batch = this.db.batch();
                    snap.docs.forEach(doc => batch.delete(doc.ref));
                    await batch.commit();
                    fromThis += snap.size;
                    deleted += snap.size;
                    if (snap.size < pageSize)
                        break;
                }
                if (fromThis === capPerCollection && !(await query.limit(1).get()).empty)
                    incomplete.push(collection);
            }
            // Deleting each committed page is the cursor: retrying the same id resumes safely.
            return { deleted, matched: dryRun ? matched : deleted, incomplete };
        };
        this.db = db;
        this.collection = "accounts" /* COLLECTIONS.ACCOUNTS */;
    }
    /**
     * Merge into the channel context. The channel now OWNS these fields — they are
     * not a copy of anything on the user record.
     */
    assertContextWriter(account, actorUserId) {
        if (!account)
            throw NotFound("Channel not found");
        if (account.deletedAt)
            throw Gone();
        if (account.orphanedAt)
            throw AccountForbidden("This channel requires owner recovery");
        if (!account.memberUids?.includes(actorUserId))
            throw AccountForbidden();
        const role = memberRole(account.members, actorUserId);
        if (role !== "owner" && role !== "editor")
            throw RoleForbidden();
    }
}
/**
 * The six tenancy collections. Every one of them carries `accountId`, which is
 * what makes this a query rather than a graph walk from the account document.
 */
AccountRepository.PURGE_COLLECTIONS = [
    "ideas" /* COLLECTIONS.IDEAS */,
    "scripts" /* COLLECTIONS.SCRIPTS */,
    "hooks" /* COLLECTIONS.HOOKS */,
    "packaging" /* COLLECTIONS.PACKAGING */,
    "videoProjects" /* COLLECTIONS.VIDEO_PROJECTS */,
    "invites" /* COLLECTIONS.INVITES */,
    // COLLECTIONS.EVENTS is deliberately ABSENT. `events` is append-only
    // telemetry, and it is the only record of what a channel did — the thing you
    // need to answer a support ticket or spot abuse after the fact, and it cannot
    // be reconstructed. Product decision: retain it and stop surfacing it to
    // users, rather than destroy it with the channel. Nothing in the API reads
    // `events`, so retaining it exposes nothing; the rows keep their `accountId`
    // and are simply unreachable once the account is tombstoned.
];
export default AccountRepository;
