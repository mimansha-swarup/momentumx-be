import { memberRole } from "../utlils/account-member.js";
import { accountRepository, accountService, videoProjectRepository, } from "../container.js";
import { AccountForbidden, Gone, NotFound } from "../utlils/errors.js";
import { isDocumentId } from "../utlils/firestore-id.js";
/**
 * Phase 05 — which channel is this request acting in, and is the caller allowed?
 *
 * Runs immediately after `authMiddleware`, on every protected router. This is the
 * plan's most security-sensitive plumbing: get it wrong and one person reads
 * another's channel by editing a value in their browser. The header is forgeable
 * by design — all of the safety is in the unconditional membership check below.
 *
 * Nothing READS `req.accountId` yet. Queries still filter `createdBy` and
 * permission checks still compare `req.userId` until Phase 06. This phase only
 * makes the context available, so Phase 06 is a small reviewable diff.
 */
export const ACCOUNT_HEADER = "x-account-id";
/**
 * Whether a request with no `X-Account-Id` may still mutate.
 *
 * FLIPPED IN PHASE 07 (was `true` through Phases 05–06b). The frontend now
 * sends `X-Account-Id` on every call — one axios request interceptor
 * (`momentumx-fe/src/utils/network.ts`) reading a module-level value hydrated
 * from `localStorage` at sign-in — so a header-less write is no longer a client
 * that has not caught up. It is a guess, and the thing it guesses wrong is
 * which channel the user's work lands in.
 *
 * The rule this protects is "the user believes they are in channel B while
 * every write lands in channel A". That became reachable the moment Phase 06a
 * shipped `POST /v1/accounts`, and is now routine: the switcher is live.
 *
 * READS still fall back, deliberately. A cold tab and an already-open tab that
 * predates the deploy both have a legitimate reason to send nothing, and
 * refusing to SHOW them anything is a worse answer than showing them the
 * channel they last activated. `resolveWithoutHeader` honours
 * `lastActiveAccountId`, so that guess is the best one available.
 *
 * Sign-in resolves the channel before fetching its profile. If the list is
 * empty, the frontend calls the authenticated, account-exempt
 * `POST /v1/accounts/bootstrap`, which atomically reuses or creates a first
 * channel. Headerless reads still retain lazy creation for older clients;
 * bootstrap and that fallback share the same transactional pointer claim.
 */
export const FALLBACK_ALLOWS_WRITES = false;
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
/**
 * Should a header-less request be refused because it mutates?
 *
 * Extracted as a pure predicate with `allowWrites` as a parameter so BOTH answers
 * are reachable from a test. Read straight off the module constant, the Phase 07
 * branch would be untestable without either re-importing the module or
 * reimplementing the condition in the test — and a test that reimplements the
 * condition asserts itself, not the code.
 */
export const fallbackRejectsWrite = (method, hasHeader, allowWrites = FALLBACK_ALLOWS_WRITES) => !hasHeader && !allowWrites && !SAFE_METHODS.has(method);
/**
 * The caller's role, read defensively.
 *
 * `account.members[uid].role` throws a TypeError — a 500 on *every* request that
 * user makes — when `memberUids` and `members` have drifted apart, which Phase 02
 * admits is possible because they are separate fields. `?? "viewer"` is least
 * privilege on drift, never most.
 */
export const roleFor = (account, uid) => memberRole(account.members, uid) ?? "viewer";
/**
 * Verify an account and attach it to the request.
 *
 * Both resolvers below end here. This was twenty duplicated lines — find,
 * tombstone, membership, attach — and a duplicated security check is one that
 * gets fixed in one place and not the other.
 */
const enterAccount = async (req, account, { clearPointerOnTombstone = false } = {}) => {
    if (!account)
        throw AccountForbidden("Channel not found");
    if (account.orphanedAt)
        throw AccountForbidden("Channel needs ownership recovery; contact support");
    // Tombstoned, not hard-deleted: 410 says "it existed", which is repairable,
    // where 404 says "it never did". Clearing the pointer is the repair path — the
    // next request falls back and finds a live membership instead of looping on a
    // dead id. Only the header path has a pointer to clear; the SSE route's id
    // comes from a project.
    if (account.deletedAt) {
        if (clearPointerOnTombstone) {
            await accountService.clearActiveAccount(req.userId, account.id);
        }
        throw Gone();
    }
    const members = Array.isArray(account.memberUids) ? account.memberUids : [];
    if (!members.includes(req.userId)) {
        // The leak detector. Costs nothing and is the only signal that someone is
        // probing ids — the request itself looks completely ordinary.
        console.warn(JSON.stringify({
            event: "account_mismatch",
            userId: req.userId,
            requestedAccountId: account.id,
            path: req.originalUrl,
        }));
        throw AccountForbidden();
    }
    req.accountId = account.id;
    req.role = roleFor(account, req.userId);
};
/**
 * Resolve the account when the client sent no header.
 *
 * `ensureDefaultAccount` fires ONLY when the user has zero memberships — not
 * "when the header is missing", and not "when lastActiveAccountId points
 * nowhere". The more permissive rule is wrong in two directions:
 *
 * - Delete a channel and the next request finds no account and mints a fresh one.
 *   Account ids are UUID v4, so the new id differs, and every document still
 *   carrying the OLD accountId becomes unreachable by any query — present,
 *   billable, invisible.
 * - A freelancer who only ever accepts an invite has no `lastActiveAccountId`, so
 *   the permissive rule mints them a phantom empty channel, and Phase 07's
 *   onboarding gate then walks them through setting up a channel they never
 *   wanted, every fresh session.
 *
 * Returns the DOCUMENT, not the id: the membership query already read it, and
 * re-reading it by id cost a second round trip on every header-less request —
 * which, until Phase 07 ships the header, is every request.
 *
 * The stored `lastActiveAccountId` decides WHICH membership, and it is resolved
 * through the same `resolveActiveAccountId` that `GET /v1/accounts` reports as
 * `activeAccountId`. This used to take `live[0]` — an `array-contains` query
 * with no `orderBy` — and ignore the pointer entirely, which meant
 * `POST /v1/accounts/:id/activate` returned 204 and changed nothing for any data
 * route. The switcher showed channel B while onboarding wrote B's niche,
 * audience and website over channel A's.
 *
 * A pointer at a tombstoned, deleted or departed channel is simply absent from
 * `live`, so it falls through to the first membership instead of 410-ing or
 * 403-ing. That is deliberate: with no header this is a GUESS, and a bad guess
 * must not lock a user out of channels they can still use. An explicitly
 * requested id still gets the 410, above.
 */
const resolveWithoutHeader = async (userId) => {
    const memberships = await accountRepository.findByMember(userId);
    const live = memberships.filter((account) => !account.deletedAt && !account.orphanedAt);
    // One channel: the pointer can only name it or something stale, so there is
    // nothing to disambiguate and no reason to pay for the user-record read.
    if (live.length === 1)
        return live[0];
    if (live.length > 1) {
        const active = await accountService.resolveActiveAccountId(userId, live);
        return live.find((account) => account.id === active) ?? live[0];
    }
    const minted = await accountService.ensureDefaultAccount(userId);
    return accountRepository.findById(minted);
};
export const accountMiddleware = (req, res, next) => {
    // Idempotent, for the same reason as `authMiddleware`: two routers share the
    // `/accounts` mount, so this otherwise resolves and re-reads the account
    // document twice per member-management request (and runs `findByMember` twice
    // for a header-less GET).
    if (req.accountId)
        return next();
    void (async () => {
        const headerValue = req.header(ACCOUNT_HEADER);
        const requested = typeof headerValue === "string" ? headerValue.trim() : "";
        // Before the value reaches `.doc()`, which would otherwise read a
        // subcollection document or throw a 500 — see `isDocumentId`. A malformed
        // header is a broken client, not a permission decision, so it is a 400 and
        // not the 403 an unknown-but-well-formed id gets.
        if (requested && !isDocumentId(requested)) {
            res.sendError({
                message: "X-Account-Id is not a valid channel id",
                statusCode: 400,
            });
            return;
        }
        if (fallbackRejectsWrite(req.method, Boolean(requested))) {
            res.sendError({
                message: "X-Account-Id is required for this request",
                statusCode: 400,
            });
            return;
        }
        const account = requested
            ? await accountRepository.findById(requested)
            : await resolveWithoutHeader(req.userId);
        await enterAccount(req, account, { clearPointerOnTombstone: true });
        next();
    })().catch(next);
};
/**
 * The one route that cannot use `X-Account-Id`.
 *
 * `GET /v1/scripts/stream/:projectId` authenticates with `?token=` because the
 * browser's `EventSource` API cannot send custom headers. So the account is
 * derived from the **project**, and nothing account-related comes from the query
 * string at all — which is stronger than the header path, not weaker.
 *
 * Two things worth knowing before trusting this:
 *
 * 1. Because both sides come from the same document, Phase 06's ownership
 *    comparison (`project.accountId !== req.accountId`) can NEVER fail here. All
 *    of the protection is the membership lookup below. Phase 06's cross-account
 *    test for this route therefore has to target a project in an account the
 *    caller is not a member of — not merely a project belonging to someone else.
 * 2. It reads the project before it can know the account, so it cannot itself be
 *    account-filtered. That is the deliberate exception to the repository rule,
 *    which is why it calls the distinctly-named `findByIdUnchecked` — when
 *    Phase 06 scopes `findById`, this call site stays correct and visible.
 *
 * It sets `req.role` as well as `req.accountId`. Phase 09 puts
 * `requireRole("editor")` on exactly this route — a GET that generates a script,
 * writes a document, completes a pipeline step and spends credits. `req.role` is
 * normally set by `accountMiddleware`, which this route deliberately skips, so
 * without this line Phase 09's gate has nothing to read and viewers keep the one
 * capability the role exists to withhold.
 */
export const resolveAccountFromProject = (req, res, next) => {
    void (async () => {
        const project = await videoProjectRepository.findByIdUnchecked(req.params.projectId);
        if (!project)
            throw NotFound("Project not found");
        // Phase 03 stamps `accountId` on every project at creation, so this is the
        // only source. There was a fallback here that minted an account for
        // `project.createdBy` when the field was missing, to cover projects written
        // before Phase 03 — it is gone along with those documents.
        //
        // Losing it is a gain, not a compromise: it wrote an account document and a
        // `lastActiveAccountId` onto a THIRD PARTY's user record, reachable by
        // anyone holding a project id, and did so BEFORE the membership check that
        // then refused them anyway. An unstamped project is now a bug, and a bug on
        // a trust boundary fails closed — refused here rather than left to
        // `findById`'s empty-id guard, which is a detail one file away.
        const accountId = project.accountId;
        if (!accountId)
            throw AccountForbidden("Channel not found");
        await enterAccount(req, await accountRepository.findById(accountId));
        next();
    })().catch(next);
};
export default accountMiddleware;
