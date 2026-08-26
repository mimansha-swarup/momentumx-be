import { NextFunction, Request, Response } from "express";
import {
  accountRepository,
  accountService,
  videoProjectRepository,
} from "../container.js";
import { IAccount } from "../types/routes/account.js";
import { AccountForbidden, Gone, NotFound } from "../utlils/errors.js";

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
 * The phase document says to make the fallback read-only — GET only, 400 for
 * anything that mutates — and that is right FROM PHASE 07, not here. Today no
 * client sends the header at all (`momentumx-fe` has no reference to it), so
 * shipping read-only would 400 every generation and every save the moment this
 * deploys.
 *
 * The rule it is protecting against — "the user believes they are in channel B
 * while every write lands in channel A" — cannot happen yet either: in this phase
 * every user has exactly one account, so the fallback resolves to the same
 * channel the header would have named. The risk appears with the switcher.
 *
 * FLIP THIS TO `false` IN PHASE 07, in the commit that makes the frontend send
 * the header. The read-only tests below are written for both settings.
 */
export const FALLBACK_ALLOWS_WRITES = true;

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
export const fallbackRejectsWrite = (
  method: string,
  hasHeader: boolean,
  allowWrites: boolean = FALLBACK_ALLOWS_WRITES
): boolean => !hasHeader && !allowWrites && !SAFE_METHODS.has(method);

/**
 * The caller's role, read defensively.
 *
 * `account.members[uid].role` throws a TypeError — a 500 on *every* request that
 * user makes — when `memberUids` and `members` have drifted apart, which Phase 02
 * admits is possible because they are separate fields. `?? "viewer"` is least
 * privilege on drift, never most.
 */
export const roleFor = (account: IAccount, uid: string) =>
  account.members?.[uid]?.role ?? "viewer";

/**
 * Verify an account and attach it to the request.
 *
 * Both resolvers below end here. This was twenty duplicated lines — find,
 * tombstone, membership, attach — and a duplicated security check is one that
 * gets fixed in one place and not the other.
 */
const enterAccount = async (
  req: Request,
  account: IAccount | null,
  { clearPointerOnTombstone = false } = {}
): Promise<void> => {
  if (!account) throw AccountForbidden("Channel not found");

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
    console.warn(
      JSON.stringify({
        event: "account_mismatch",
        userId: req.userId,
        requestedAccountId: account.id,
        path: req.originalUrl,
      })
    );
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
 */
const resolveWithoutHeader = async (userId: string): Promise<IAccount | null> => {
  const memberships = await accountRepository.findByMember(userId);
  const live = memberships.filter((account) => !account.deletedAt);
  if (live.length > 0) return live[0];

  const minted = await accountService.ensureDefaultAccount(userId);
  return accountRepository.findById(minted);
};

export const accountMiddleware = (
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  void (async () => {
    const headerValue = req.header(ACCOUNT_HEADER);
    const requested = typeof headerValue === "string" ? headerValue.trim() : "";

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
export const resolveAccountFromProject = (
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  void (async () => {
    const project = await videoProjectRepository.findByIdUnchecked(
      req.params.projectId
    );
    if (!project) throw NotFound("Project not found");

    // Legacy projects predate Phase 03 and carry no accountId until Phase 04
    // backfills them. Falling back to the owner's account keeps the stream
    // working through the migration window; the membership check still runs, so
    // this is not a way in.
    const stamped = (project as { accountId?: string }).accountId;

    // But only the creator may trigger that fallback. Minting on any caller's
    // behalf wrote an account document and a `lastActiveAccountId` onto a THIRD
    // PARTY's user record — reachable by anyone holding a project id, and done
    // before the membership check that then 403'd them anyway.
    //
    // This narrows the route: a non-creator member of the project's account is
    // refused while the project is unstamped. Nobody can hit that, and the
    // reason is ORDERING, not the account's existence — the creator may well
    // have an account already. Sharing does not exist until Phase 09, and
    // Phase 04's backfill stamps every project long before it, so an unstamped
    // project only ever has one possible member. If Phase 09 were ever to land
    // ahead of a completed Phase 04, this line would have to go.
    if (!stamped && project.createdBy !== req.userId) throw AccountForbidden();

    const accountId =
      stamped || (await accountService.ensureDefaultAccount(project.createdBy));

    await enterAccount(req, await accountRepository.findById(accountId));
    next();
  })().catch(next);
};

export default accountMiddleware;
