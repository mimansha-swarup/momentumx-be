---
title: "Phase 05 — Account Context in the API"
description: "Add the X-Account-Id header, verify membership once per request, and expose req.accountId."
date: 2026-08-19
last_updated: 2026-08-26
status: "code-complete — not yet deployed"
tags: ["multi-account", "phase-05", "api", "security"]
---

# Phase 05 — Account Context in the API

**Size:** small in code, high in care. This is a new trust boundary.
**Depends on:** Phase 04 verified.
**Blocks:** Phase 06.

---

## Where this stands (2026-08-26)

Built and tested; **not deployed**. Suite: 897 tests, 59 suites.

| | |
|---|---|
| `code` on the error contract (4 files) | done — `tests/unit/error-code-contract.behaviour.test.ts` |
| `accountMiddleware`, mounted on all 7 routers | done — `tests/unit/auth-coverage.test.ts` pins the mount AND the order |
| `resolveAccountFromProject` on the SSE route | done |
| Tombstone → 410, pointer cleared | done |
| CORS `X-Account-Id` | done |
| `.claude/rules/api-design.md` updated | done, same change as required |
| Rate limiter keyed on `userId` | **NOT done — see below** |
| Deployed + browser CORS check | **outstanding** |

**"Depends on: Phase 04 verified" gates the DEPLOY, not the build.** This phase only makes
`req.accountId` available; nothing reads it until Phase 06, so it is inert against
un-backfilled data.

### Two corrections to this document

**1. The read-only fallback cannot ship in this phase.** The rule below says to allow the
header-less fallback for `GET` and return 400 for anything that mutates. No client sends the
header yet — `momentumx-fe` contains no reference to it until Phase 07 — so shipping that
would 400 every generation and every save on deploy. And the risk it guards against ("the
user believes they are in channel B while every write lands in channel A") cannot occur
here: every user has exactly one account, so the fallback resolves to the same channel the
header would have named.

Shipped permissive, behind `FALLBACK_ALLOWS_WRITES` in `src/middleware/account.ts`.
**Phase 07 flips it to `false`** in the commit that makes the frontend send the header. Both
settings are already covered by tests, so the flip is one line.

**2. Keying the rate limiter on `userId` is not a "while you're in the file" change.**
`app.use(rateLimiter)` runs at `app.ts:49`, before `app.use(rootRouter)` at `:61`, and
`authMiddleware` lives *inside* the routers — so `req.userId` is always `undefined` when the
key is computed. A `keyGenerator: (req) => req.userId || req.ip` compiles, passes every
test, and silently stays per-IP forever. Doing it properly means moving the limiter after
auth (leaving the unauthenticated surface unlimited) or mounting a second per-user limiter
at router level. Deferred to Phase 09, with the reasoning recorded in `rate_limit.ts`.

---

## The idea in simple English

Every request already says *who you are* — `authMiddleware` verifies the Firebase token
and sets `req.userId`. Now every request also needs to say *which channel you're working
in*, and the server has to check you're actually allowed in that channel.

This is the most security-sensitive piece of plumbing in the plan. Get it wrong and one
person can read another's channel by changing a value in their browser.

---

## How the account travels

**A request header: `X-Account-Id`.**

The alternatives and why not:

- **In the request body** — forbidden by the project's own API rules
  (`.claude/rules/api-design.md`): identity never comes from the body. An account id is
  identity.
- **In the URL path** (`/v1/accounts/:id/ideas`) — the most self-documenting option, and
  genuinely tempting. Rejected because it rewrites every route and every frontend service
  call for no security gain: a path parameter is exactly as forgeable as a header, and both
  need the same membership check.

The header wins on diff size while being equally safe, **provided the check is
unconditional**.

## The middleware

Runs immediately after `authMiddleware`, on every protected router:

```
accountMiddleware(req, res, next):
  accountId = req.header("X-Account-Id")

  if missing:
      accountId = users/{req.userId}.lastActiveAccountId
      if still missing → ensureDefaultAccount(req.userId)

  account = accounts/{accountId}
  if not found                              → 404
  if req.userId not in account.memberUids   → 403, log { event: "account_mismatch" }

  req.accountId = accountId
  req.role      = account.members[req.userId].role
  next()
```

Five rules, two of which the pseudo-code above depends on:

**Read the role defensively.** `account.members[req.userId].role` throws a `TypeError` —
a 500 on *every* request that user makes — if `memberUids` and `members` have drifted
apart. Phase 02 admits that redundancy is possible. Use `?? "viewer"`: least privilege on
drift, never most.

**`ensureDefaultAccount` fires only when the user has ZERO memberships.** Not "when the
header is missing", and not "when `lastActiveAccountId` points nowhere". This rule replaces
an earlier, more permissive one ("fall through on a missing account too"), which was wrong
in two directions:

- **It silently strands a deleted channel's data.** Delete a channel, and the next request
  finds no account and **mints a fresh one**. Because account ids are UUID v4, the new id
  differs from the old, so every `ideas` / `scripts` / `hooks` / `packaging` /
  `videoProjects` document still carrying the *old* `accountId` is now unreachable by any
  query — present, billable, invisible. (Under the abandoned `accountId === uid` scheme the
  failure was the mirror image: the re-created account reused the id and the "deleted"
  channel's content all reappeared. Different symptom, same rule.)
- **It mints phantom channels for invited-only users.** A freelancer who only ever accepts
  an invite has no `lastActiveAccountId`, so the old rule creates `accounts/{their-uid}`
  with empty channel fields. Phase 07's onboarding gate then drops them into setting up a
  channel they never wanted, on every fresh session.

The rule, concretely:

```
if no header and no lastActiveAccountId:
    accounts = query where memberUids array-contains userId, limit 1
    if any  → use it, and set lastActiveAccountId
    else    → ensureDefaultAccount(userId)
```

**Accounts are tombstoned, never hard-deleted.** `deletedAt` on the document; a tombstoned
account returns **410 Gone** and the middleware clears `lastActiveAccountId` so there is
still a repair path — which is what the old rule was reaching for. `ensureDefaultAccount`
already returns early when the document exists, so a tombstone is inherently
un-overwritable.

**Deletion must also purge the `usage` subcollection.** Firestore does not delete
subcollections with their parent, and `accounts/{id}/usage/{YYYY-MM}` is keyed by month — so
a resurrected or re-created channel would inherit the current month's usage document and
report spend it never made. Same for the five tenancy collections: there is no cascade, so
account deletion has to enumerate and delete, or mark and sweep.

**Fall back rather than reject when the header is missing.** A hard 400 would break every
already-loaded browser tab the moment the backend deploys. The fallback keeps old clients
working through the transition. Phase 10 can tighten this to a hard requirement once every
client sends the header.

**Log every rejection** as a structured `account_mismatch` event. That is your leak
detector, and it costs nothing — the codebase already logs this way throughout the
services.

**Make the fallback read-only.** Allow it for `GET`; return 400 for anything that mutates.
The header is dropped silently if CORS isn't updated (see below), and a fallback that
accepts writes means the user believes they're in channel B while every write lands in
channel A — silent cross-tenant data placement, tests all green. Read-only means the worst
case is a stale list, not corrupted data.

**One document read per request.** Acceptable, and it's the same read the existing code
already does for the user profile in several places. If it ever matters, cache membership
in the verified token's custom claims — but don't optimise this before it hurts.

---

## The exception: the script streaming route

`GET /v1/scripts/stream/:projectId` uses `sseAuthMiddleware` with a `?token=` query
parameter, because the browser's `EventSource` API **cannot send custom headers**. That's
documented in `src/middleware/auth.ts` and mirrored in
`momentumx-fe/src/hooks/useScriptStream.tsx`.

So this one route cannot use `X-Account-Id`, and the claim "the account never comes from
the request" is not universally true. **Write the exception down rather than letting an
implementer quietly skip the middleware.**

**Decision: derive the account from the project.** The route already receives
`:projectId`. Load the project, take its `accountId`, and verify the user is a member of
*that* account. Nothing account-related comes from the query string at all — which is
stronger than the header path, not weaker.

**It must set `req.role` as well as `req.accountId`.** Phase 09 requires
`requireRole("editor")` on exactly this route — a `GET` that generates a script, writes a
document, completes a pipeline step and spends credits. But `req.role` is normally set by
`accountMiddleware`, which this route deliberately skips. Read
`account.members[uid].role ?? "viewer"` in the same resolver, or Phase 09's gate has nothing
to check and viewers get the one capability the role exists to withhold.

Implement it as one named middleware — `resolveAccountFromProject` — mounted per-route
beside `sseAuthMiddleware`, so there is a single thing to audit rather than inline code in
the controller.

**Know what this check does and does not prove.** Because the account is derived from the
project, the ownership comparison Phase 06 adds (`project.accountId !== req.accountId`)
**can never fail on this route** — both sides came from the same document. All of the
protection sits in the membership lookup inside the resolver. That is sound, but it means
Phase 06's cross-account test for this route has to target *a project in an account the
caller is not a member of*, not merely a project belonging to someone else.

**Bootstrap read exception.** This resolver has to read the project before it can know the
account, so it cannot itself be account-filtered. That is the one deliberate exception to
Phase 01's repository rule; give it a distinct method name (`findByIdUnchecked`) used only
here, so the exception is visible rather than assumed.

---

## Two things that will break in production if forgotten

**1. CORS.** `src/app.ts` sets an explicit allowlist:

```ts
allowedHeaders: ['Content-Type', 'Authorization']
```

Ship `X-Account-Id` without adding it here and **every preflighted request fails in the
browser while every test passes**, because tests don't do CORS preflight. This is the same
shape as the stale-index outage: configuration outside the code path under test.

**2. Rate limiting.** `src/middleware/rate_limit.ts` limits per IP, 100 requests per 15
minutes. Several members of a shared channel in one office share one budget, and switching
channels refetches a lot at once. Not a blocker for this phase — but it will become a
support ticket after Phase 09, and it's cheaper to key the limiter on `userId` now while
you're in the file.

---

## Decide the error contract here

Phase 07 wants a global handler that treats 403 as "you're not in this channel" and ejects
the user. Phase 09 returns 403 for "you're a viewer, you can't do that". **The same status
cannot mean both** — a viewer clicking anything the UI failed to disable would be thrown out
of the channel.

The error body today carries `{ success, message, detail }` — `res.sendError` at
`src/middleware/response_formatter.ts:25-32`. (`statusCode` is the HTTP status, **not** a
body field; an earlier draft of this document said otherwise.) Add a machine-readable
`code`, decided now rather than discovered in Phase 09:

| code | Meaning | Client behaviour |
|---|---|---|
| `account_forbidden` | Not a member of this account at all | Clear the active account, go to the channel list |
| `wrong_account` | Member of the resource's account, but currently acting in a different one | Offer a one-click switch — see below |
| `role_forbidden` | Member, but the role doesn't allow it | Show an inline message, stay put |
| `insufficient_credits` | Phase 08 | Show the balance and the reset date |

**`wrong_account` is worth the extra code.** Without it, opening a bookmarked project that
lives in your *other* channel returns a bare 403 or 404, and
`momentumx-fe/src/components/project/ProjectPipelineLayout.tsx:16` renders **"Project not
found. It may have been deleted."** The project is not deleted — it is one switch away, and
the server knows both the project's `accountId` and the user's memberships. Return the
account id and display name in `detail` so the client can say *"This video lives in Cooking
with Sam — switch to that channel?"*.

Right after a migration whose two loudest risks are "a missed query shows an empty list" and
"backfilled records become invisible", telling a user their work was deleted when it wasn't
is the worst sentence this product can produce.

### Adding `code` touches four files the phase didn't name

It is not a one-line change, and if any link is missed the field never reaches the browser:

| File | Change |
|---|---|
| `src/utlils/errors.ts` | `HttpError` gains a `code` property, so `Forbidden()`-style factories can carry one |
| `src/types/customTypes.d.ts` | `sendErrorProps` gains `code` |
| `src/middleware/response_formatter.ts` | `sendError` emits it |
| `src/middleware/error_handler.ts` | the 4xx branch forwards it — today it passes only `message` |

The Phase 07 global 403 handler is useless without this, and Phase 09 breaks viewers
without it.

---

## What does NOT change yet

Nothing reads `req.accountId`. Queries still filter `createdBy`, permission checks still
compare against `req.userId`. This phase only makes the context *available*, so that
Phase 06 is a small, reviewable change rather than a large one.

---

## Update the convention file in this commit

`.claude/rules/api-design.md:73` documents the error body as
`{ success: false, message, detail? }` and `res.sendError({ message, statusCode?, detail? })`.
This phase adds `code`. Update that section here, not in Phase 10.

That file is loaded into every session as an instruction, so a stale version doesn't merely
fail to help — it tells the next person to send an error without a code. Nothing throws;
Phase 07 simply cannot tell `account_forbidden` (eject to the channel list) from
`role_forbidden` (stay put, inline message), and renders both as a generic 403.

**The standing rule:** a phase that changes a convention updates the convention file in the
same commit. Phase 10 keeps only the end-state tidy.

---

## How we'll know it worked

- A request with a valid `X-Account-Id` succeeds; `req.accountId` and `req.role` are set.
- A request with **someone else's** account id returns 403 and logs `account_mismatch`.
- A request for a non-existent account returns 404.
- A request with **no** header still works, using the fallback.
- A browser request from the real frontend origin succeeds with the header present — the
  CORS check. Verify in a browser, not with `curl`; curl doesn't do preflight.
- The SSE stream still works and resolves its account from the project.

---

## Rollback

Remove the middleware from the routers. Nothing depends on it yet.

---

## Risks

**Forgetting the CORS header** is the most likely mistake and the most confusing to debug —
everything works locally and in tests, and fails only in a real browser.

**Applying the middleware unevenly** is the dangerous one. A route that skips it has no
account context, so when Phase 06 makes queries account-scoped, that route either crashes
or falls back to something wrong. The project already has a test that walks every route
file asserting auth is mounted (`tests/unit/auth-coverage.test.ts`); extend the same
pattern to assert `accountMiddleware`, and the problem can't recur.
