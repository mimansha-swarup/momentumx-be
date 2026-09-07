---
title: "Phase 06a — The Accounts API"
description: "List, create, and activate channels. The endpoints the switcher talks to."
date: 2026-08-24
last_updated: 2026-08-30
status: "code-complete — not deployed"
tags: ["multi-account", "phase-06a", "api"]
---

# Phase 06a — The Accounts API

## Where this stands (2026-08-30)

Code done, **not deployed**. Suite: 1038 tests, 66 suites, green; `tsc` clean; `dist/` current.

| | |
|---|---|
| All six endpoints | done |
| `buildOwnedAccount` — the one writer of the three membership fields | done, both creation paths use it |
| `GET`/`POST` exempt from `accountMiddleware` | done, pinned by a named allowlist in `auth-coverage.test.ts` |
| `isOnboarded` / `projectCount` / `role` | done, 32 service tests + 8 route tests |
| `.claude/rules/api-design.md` updated | done, same commit |
| `isOnboarded` becomes true once the channel is onboarded | done — Phase 06b landed with it |

**`isOnboarded` is derived from the ACCOUNT's context subcollection**, and
[Phase 06b](./phase-06b-move-channel-context.md) — which shipped with this — is what makes
onboarding write there. Before it, that flag could never become true for a channel created
by `POST /v1/accounts`, and the switcher would have routed the user back to onboarding every
time they picked it. Sourcing it from the user record instead was not an option: then every
channel reports the first one's answers, and a channel created seconds ago claims to be set
up.

---

**Size:** small — one router, one controller, one service, one repository.
**Depends on:** Phase 06.
**Blocks:** Phase 06b and Phase 07. Both are unrunnable without it.

---

## Why this phase exists

An earlier draft of this plan had no Accounts API at all. Grepping all of the phase
documents for `/v1/accounts` returned exactly one hit, and it was Phase 05 *rejecting*
path-based routing as an alternative to the `X-Account-Id` header.

`ensureDefaultAccount` (Phase 03) creates exactly **one** account per user, lazily, keyed on
their uid. It is a bootstrap, not a "create a second channel" primitive. So as drafted:

- **Phase 06b could not be verified.** Its acceptance test is "set up channel A, set up
  channel B, switch to B, generate" — one user, two channels. No code path could produce
  the second one.
- **Phase 07 had no server to call.** The switcher, "add a channel", and persisting
  `lastActiveAccountId` were all specified as frontend behaviour with no endpoint behind them.

Note what this phase is *not* needed for: **Phase 06's cross-account test suite.** That needs
two accounts, and two separately-signed-up users already have two, via `ensureDefaultAccount`.
Phase 06 is verifiable without this phase, which is why this lands after it.

---

## The endpoints

All under `router.use(authMiddleware)`.

**`GET /v1/accounts` and `POST /v1/accounts` must be exempt from `accountMiddleware`.** You
cannot present an `X-Account-Id` you do not have yet, and a brand-new user's first list call
would otherwise fall into Phase 05's fallback path.

```
GET /v1/accounts               → the switcher's list
{ success: true, data: {
    accounts: [{
      id, name, handle, photoURL,
      role: "owner" | "editor" | "viewer",
      isOnboarded: boolean,
      projectCount: number,
      completeness: { score, missing[] } | null,
      credits: { remaining, resetsAt } | null   // null unless I am the billing owner
    }],
    activeAccountId: string        // the server's lastActiveAccountId, for a fresh tab
} }
```

Three of those fields are load-bearing and were not obvious:

- **`role`** — Phase 09's read-only UI covers seven screens and there is no role anywhere
  client-side today. This is where it comes from.
- **`isOnboarded`** — the switcher routes on it. Pick a channel with `isOnboarded: false`
  and you land on onboarding, not the dashboard. Deriving it client-side would duplicate
  `selectIsOnboarded`'s rule (`momentumx-fe/src/utils/feature/user/user.slice.ts:110-114`)
  in two places that would drift.
- **`projectCount`** — the cheapest defence against the silent-data-loss class that Phase 04
  and Phase 06 both name as their top risk. A user whose projects vanished sees "0 videos"
  next to a channel they know has forty, from the switcher menu, without opening it. So does
  support, in one screenshot.

```
POST /v1/accounts              → create a channel
body: { }                      // empty, deliberately
→ 201 { data: { account } }    // isOnboarded: false
```

**The empty body is a decision, not an oversight.** Onboarding already owns URL entry,
prefill and confirmation, and it needs a real account id to send `X-Account-Id` against.
Create-then-onboard means the existing `POST /v1/user/onboarding/prefill` and
`PATCH /v1/user/onboarding` are reused unchanged, with only the header differing. It also
means abandoning setup leaves a visible half-configured channel in the switcher that the
user can return to or delete — which is exactly what Phase 07's "leave without finishing
setup" acceptance check requires. A one-shot create-with-URL would leave nothing behind and
strand them.

```
POST /v1/accounts/:id/activate → set lastActiveAccountId. 204.
GET  /v1/accounts/:id          → one channel in full (the settings screen)
PATCH /v1/accounts/:id         → channel edits (owner). Replaces the channel half of
                                 PATCH /v1/user/profile once Phase 06b step 4 lands.
DELETE /v1/accounts/:id        → owner only; refuses the user's last channel
```

---

## One helper writes membership. Always.

Phase 02 and Phase 09 both state the rule: `memberUids`, `ownerUids` and `members` must
never be assembled by a caller. As originally drafted this plan broke its own rule at the
design level — `ensureDefaultAccount` assembled all three inline, and `POST /v1/accounts`
would have been a second independent writer of the same three fields.

Extract one helper, `createAccountWithOwner(uid, channelFields)`, and have **both** call it.
Same transaction, same three fields, one implementation.

`ensureDefaultAccount` stays as the lazy, idempotent bootstrap for a user's *first* account.
`POST /v1/accounts` is for every account after that. Both mint a UUID v4 the same way.

**RESOLVED 2026-08-25 — always a UUID v4.** There is no first-channel special case: every
account id is a fresh `randomUUID()`, including a brand-new user's first one. This removes
the two-kinds-of-channel problem entirely, and it is what makes `DELETE /v1/accounts/:id`
actually delete — under the old `accounts/{uid}` scheme the next request would lazily
recreate the channel the user just removed. See the decisions section of the README.

---

## Two rules inherited from other phases

**`ensureDefaultAccount` fires only when the user has zero memberships.** Not "when the
header is missing", and not "when `lastActiveAccountId` points nowhere". Otherwise a
freelancer who only ever accepted an invite gets a phantom empty channel minted for them,
and Phase 07's onboarding gate drops them into setting up a channel they never wanted, every
session. Query `memberUids array-contains uid` first; if anything comes back, pick one and
set `lastActiveAccountId` instead of creating.

**Deleted accounts are tombstoned, never hard-deleted.** See Phase 05. The original reason
was sharper — with `accountId === uid`, a hard delete plus a lazy re-create brought the
channel back with all its data attached. UUID ids remove that resurrection path, but the
tombstone still earns its place: it distinguishes "this channel was deleted" (410 Gone) from
"this id never existed" (404), which is what stops a stale bookmark or a shared link reading
as a bug. `DELETE` here sets
`deletedAt` and then purges the channel's data, which Firestore does not delete with its
parent: the six tenancy collections by `accountId` (`ideas`, `scripts`, `hooks`,
`packaging`, `videoProjects`, `events`) and `accounts/{id}/context/channel` — the one
holding the niche, the competitor list and the scraped website text.
`accounts/{id}/usage/**` has no documents until Phase 08 and is swept with the code that
starts writing it.

**This shipped as a tombstone-only delete and was marked done for two phases.** The
content stayed present and billable, unreachable only because every query filters
`accountId`. The purge is capped and runs inline; a channel above the cap keeps the
remainder behind the tombstone rather than becoming visible again, and Phase 10 is where
an unbounded resumable sweep belongs.

The last-channel refusal is now counted and tombstoned in **one transaction**
(`softDeleteUnlessLast`). Read-check-write let two concurrent deletes both pass and leave
the user with zero channels — the exact outcome the guard exists to prevent.

---

## Update the convention file in this commit

`.claude/rules/api-design.md` carries the route inventory and its own instruction to update
it whenever an endpoint is added or changed. Add the `/v1/accounts` routes there in this
commit, including the note that `GET` and `POST /v1/accounts` are **exempt from
`accountMiddleware`** — that exemption is easy to lose and locks a user out of their own
channel list if it is.

---

## How we'll know it worked

- A user with one channel sees exactly one row, with the right `role` and `projectCount`.
- `POST /v1/accounts` creates a second channel; `GET` now returns two.
- The new channel reports `isOnboarded: false` until it has a URL, or a niche and audience.
- `GET`/`POST` work with **no** `X-Account-Id` header at all — the exemption.
- `projectCount` matches what the dashboard shows after switching into that channel. If
  these two disagree, one of the Phase 06 query filters is wrong, and this is how you find out.
- `DELETE` refuses the last channel, and a deleted channel does not reappear on the next
  request.
- A user who is only ever an invited member never has an account minted for them.

---

## Rollback

Remove the router. Nothing depends on it until Phase 06b, and no data shape changes —
`POST /v1/accounts` writes documents in the shape Phase 02 already defined.

---

## Risks

**Low.** The one thing to get right is that `createAccountWithOwner` is genuinely the only
writer of the three membership fields. If a second inline writer appears here, the drift
that Phase 09's member management is built to prevent starts at the moment accounts are
created rather than at the moment they are shared.
