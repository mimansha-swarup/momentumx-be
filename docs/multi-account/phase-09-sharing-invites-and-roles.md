---
title: "Phase 09 — Sharing: Invites and Roles"
description: "Invite links, role enforcement, and read-only states across the UI."
date: 2026-08-19
last_updated: 2026-10-18
status: "locally accepted — deployment not performed"
tags: ["multi-account", "phase-09", "sharing", "permissions"]
---

# Phase 09 — Sharing: Invites and Roles

## Backend hardening — 2026-10-18

Independent HTTP acceptance passes 29 checks, including deleted-channel preview privacy,
stale/missing profile emails, member removal/demotion, fresh re-invitation, Auth deletion,
submillisecond timestamp ordering, prototype-named UIDs and bounded/resumable cleanup.
UID markers live in a subcollection and commit atomically with membership changes, so an
old invite cannot restore revoked access. New links issued after the change remain usable.
See [maintenance commands and deployment gates](./operational-readiness.md#backend-hardening--2026-10-18).

## Local acceptance — 2026-09-26

Implemented: owner-managed seven-day invite links and pending inbox, public masked
preview, verified-email single-use transactional acceptance, revocation, member/role
management, leave and ownership transfer, billing-owner/last-owner guards, server role
gates and frontend viewer states. Frontend wrong-account/removed-member recovery and
unsaved-text recovery are covered by mounted checks. No email is sent.

Backend coverage includes real HTTP routers, expiry/replay/claim mismatches, concurrent
acceptance and membership changes, atomic authorization before channel deletion, and
safe wrong-account disclosure. Frontend acceptance is part of the 174-test/24-file suite,
including 19 mounted interaction and 11 stream parser/status checks.

There is **no app login-deletion API**. Direct Firebase SDK/admin deletion cannot be
prevented by this backend; the separate `onDeleteUser` Function reconciles memberships.
Deleting the last owner or billing payer explicitly orphans/freezes the channel for
operator recovery while preserving its content. Ordinary member deletion does not
freeze other members. This supersedes the unconditional login-deletion wording below.

The remaining design text is historical detail; implemented behavior and exceptions
above take precedence. Deploy invitation indexes and Functions, audit identity providers,
and run staged acceptance before exposing sharing. See [operational readiness](./operational-readiness.md).


**Size:** small backend, large frontend.
**Depends on:** Phase 07.

---

## What users get

An owner can invite someone to a channel with a link. The invited person opens it, signs
in, and gets access at the level they were given.

| Role | Can do |
|---|---|
| **Owner** | Everything — invite, change roles, remove members, delete the channel |
| **Editor** | Generate, edit, regenerate, delete projects. **No member management** |
| **Viewer** | Read and export only. **No generation** |

Two rules that never bend:

- A channel **always keeps at least one owner.** The last owner cannot leave, be demoted,
  or be removed.
- You **cannot delete your login** while you are the last owner of any channel. Hand it
  over or delete the channel first.

---

## Invites without email

Firebase has no general email service. Sending mail needs either the Trigger Email
extension or a Cloud Function calling an external provider — and both need outbound network
access, which requires the **paid Blaze plan**.

**Correction to an earlier draft:** this document previously asserted "this project is on
Spark". That was never measured and is wrong — the project is on **Blaze today**. The
decision below is unchanged, but for a different and better reason: the stated intent is to
operate within Spark constraints, so the no-email design is the one that survives a
downgrade. See the README's plan-constraints section.

**This is an inverse trap worth naming.** Because Blaze is active *right now*, someone can
install the Trigger Email extension and it will work — right up until a downgrade, when
invites appear sent and silently are not. The Spark-safe design is already written; the trap
is that Blaze makes abandoning it tempting.

**So we don't send email.** The owner gets a link and shares it however they already talk
to that person.

### How the link works

```
invites/{token}
  accountId, email, role, invitedBy, status, expiresAt, createdAt
```

**The token is the document id.** Generate 32 random bytes, base64url-encode them (43
characters). Acceptance is then a direct get-by-id — no `where("token", "==", …)`, so no
index, and no way to probe for valid tokens through a query.

**Accepting must be one transaction.** Read the invite, check it's still `pending`, not
expired, and that the signed-in user's email **matches the invite's email**; then in the
same transaction write `status: "accepted"` and add the member. "Single-use" is only real
if the status read and write are atomic — otherwise a double-click or two open tabs both
succeed.

**Require `email_verified` on the token.** Matching the email is not enough on its own: if
any non-Google sign-in provider is enabled in the Firebase console, an attacker can call
Identity Toolkit directly and mint a token whose `email` claim is anyone's, unverified.
`authMiddleware` reads only `uid` today, so nothing else would catch it. Check
`decodedToken.email_verified === true` at acceptance, and audit which providers are enabled
before shipping invites.

Compare **lowercased-exact**. Do not "helpfully" normalise Gmail dots or `+` aliases — that
would make `victim+x@gmail.com` a valid claim on `victim@gmail.com`.

**Why the email must match:** links get forwarded. Possession alone would let anyone the
link reached into the channel. If you later want a deliberate "anyone with this link" mode,
add it as an explicit invite type rather than by loosening this.

**Expiry:** set `expiresAt`. Two corrections to an earlier draft here, both load-bearing:

**TTL *is* declarable in `firestore.indexes.json`.** The `fieldOverrides` schema includes a
`ttl` flag — it does not have to be a console-only setting:

```jsonc
{ "collectionGroup": "invites", "fieldPath": "expiresAt", "ttl": true, "indexes": [] }
```

That matters beyond pedantry: Phase 00's whole thesis is that config belongs in the repo
where it is reviewable, and a TTL policy set only in the console is exactly the unreviewable
config Phase 00 exists to eliminate. The `"indexes": []` in the same entry also applies the
documented best practice of exempting TTL fields from automatic indexing.

**TTL deletes require billing.** They are excluded from Spark's free usage. So on a
downgrade the policy stops running.

**Expiry enforcement does not depend on TTL.** The `expiresAt` check inside the acceptance
transaction is the load-bearing one; TTL only reclaims storage. Say so explicitly in the
code, because "TTL handles expiry" is precisely the reasoning that gets the transaction
check deleted as redundant — and that would turn an expired invite into a valid one.

### Pending invites in the app

Also store the invited email on the invite. When someone signs in, query
`invites where email == <their email> and status == pending` and show them in-app. No
sending required — they simply find it waiting.

**Known gap:** if someone is invited at one address but signs in with a different provider
or address, the lookup misses. That gap is only survivable because state **C** below names
it on screen.

---

## The invite screen — the whole feature, and it had no route

Since no email will ever be sent, `/invite/:token` **is** the sharing feature. The original
draft specified the token, the transaction, the email match and the expiry, and never
specified the screen — so every failure mode landed on the marketing page:
`momentumx-fe/src/constants/route.tsx:119` is `{ path: "*", element: <Navigate to="/" /> }`,
and there is no invite route anywhere.

**Register it at the top level**, beside `/login` — **not** under `/app`, because an invitee
arriving cold is unauthenticated and `ProtectedLayout` would bounce them
(`ProtectedRoute/index.tsx:42-43`).

**Keep the token in the path, never a query string.** `Login/index.tsx:16-17` redirects using
`state?.from?.pathname` only — it discards `search` and `hash`, so a `?token=` invite would
silently lose the token across sign-in. A path segment survives.

### Two endpoints

```
GET  /v1/invites/:token          UNAUTHENTICATED — the 43-char token is the secret
→ { accountName, invitedByName, role, emailMasked: "j••••@gmail.com", status, expiresAt }

POST /v1/invites/:token/accept   authenticated; runs the transaction
→ 200 { account }
→ 403 { code: "invite_email_mismatch" | "invite_expired" | "invite_used" | "invite_email_unverified" }
```

The read is unauthenticated so the page can say *who invited you, to which channel, at what
role* **before** forcing a sign-in — otherwise the user is asked to authenticate against an
unexplained URL. **Mask the invitee address**: the link is forwarded by design, and the
holder should not learn the target's email from it.

Distinct `code`s per refusal, because "wrong Google account" is the common case and a
generic failure sends the user nowhere.

### Four states, one component

**A — signed out**
> ### {inviterName} invited you to {channelName}
> You'll join as **{role}**. {editor: "You can generate, edit and export everything in this channel." | viewer: "You can read and export everything in this channel."}
> **[ Sign in with Google to accept ]**
> Sign in with **{emailMasked}** — this invite only works for that address.

Sign-in reuses what exists: navigate to `/login` with
`state: { from: { pathname: "/invite/" + token } }`, which `Login/index.tsx:16-17` already
honours. No new plumbing.

**B — signed in, email matches.** Button becomes **[ Join {channelName} ]**. On success,
switch to the new account using Phase 07's sequence with the destination set to the
dashboard, and toast *"You're in {channelName}."*
**Do not run the onboarding gate on an invited channel** — it is already configured, and a
viewer could not configure it anyway. Phase 07's gate reads the *account's* setup state,
which an established channel passes.

**C — signed in, wrong email**
> ### This invite is for a different account
> {inviterName} invited **{emailMasked}** to {channelName}. You're signed in as **{currentEmail}**.
> **[ Sign out and use another account ]**  [ Go to my channels ]

**D — expired / already accepted / revoked**
> ### This invite is no longer valid
> {expired: "It expired on {date}." | used: "It's already been used." | revoked: "It was cancelled."}
> Ask {inviterName} to send a new one.

Never redirect silently to `/` in any of these. With no email delivery, **the human relay is
the recovery path**, so every terminal state has to name what happened and who to ask.

---

## Enforcing roles

`req.role` is already set by `accountMiddleware` from Phase 05. Enforcement is a small
guard:

```ts
requireRole("editor")   // owner or editor
requireRole("owner")    // owner only
```

Applied per route:

| Routes | Minimum role |
|---|---|
| Reads and `/export` | viewer |
| `/generate-*`, `/regenerate*`, `/save`, `/edit`, and every other mutation | editor |
| **`GET /v1/scripts/stream/:projectId`** | **editor** |
| `GET /v1/research/*` | editor — see below |
| Member management, role changes, delete channel, billing | owner |

**Gate by effect, not by HTTP method.** The SSE script route is a `GET` that generates a
script, writes a document, completes a pipeline step and (after Phase 08) spends the billing
owner's credits. Reading the method would hand viewers exactly the capability the role
exists to withhold.

`GET /v1/research/*` is a genuine read, but it burns project-wide YouTube quota — and Phase
08 measures the headroom at roughly 50 idea generations per day for *all* users combined. A
viewer on a shared channel could drain it for every tenant. Editor is the safer default.

**Viewers cannot generate.** That's the whole reason the role exists — generation spends
the billing owner's credits and writes documents.

Extend `tests/unit/auth-coverage.test.ts`, which already walks every route file asserting
auth is mounted, to assert every mutating route carries a role guard. That makes it
impossible to add an unguarded route later without the suite noticing.

---

## The frontend is the bigger half

Every screen needs a read-only version for viewers:

- Dashboard — no create project
- Research / ideas — no generate, no regenerate, no "Use Idea"
- Script — no generate, no edit, no regenerate
- Hooks — no generate, **no select** (selection is a mutation), no regenerate
- Title — no generate, no select, no edit
- Packaging — no generate, no regenerate, no editing, export still allowed
- Settings — read-only channel details
- **"Add a channel" stays available.** An earlier draft said "no add channel for
  non-owners". That is wrong: adding a channel is a *personal* action against your own
  login, not an action on the current channel. Blocking it means a freelancer invited to a
  client's channel before creating their own is locked out of the product's core capability,
  with no error that explains why. The correct boundary is: **member management of the
  current channel** is owner-only.

### One banner, not twenty tooltips

An earlier draft proposed the `title`-attribute pattern used on the disabled regenerate
buttons. That is right for a *transient* state the user just caused ("Save or cancel your
edit first"); it is wrong for a permanent role boundary across roughly twenty buttons on
seven screens. `title` doesn't fire on touch, doesn't fire on keyboard focus, and a
`disabled` button isn't focusable — so it is unreachable by keyboard and screen reader
entirely.

Instead: **one persistent banner in the app shell**, rendered inside `RootLayout` where
Phase 07 already places `key={activeAccountId}`:

> **View-only.** You can read and export everything in {channelName}. Ask {ownerName} for
> edit access.

That single banner is what makes the disabled controls legible. Keep `aria-disabled` and a
real title on the *wrapper* so it stays focusable.

### Rebuild viewer action bars, don't de-button them

`Research/index.tsx:235-279` renders Export, Regenerate All and Generate More in one row;
same shape at `ProjectPackaging/index.tsx:389-426` and `ProjectHooks/index.tsx:362-400`. A
row of three greyed buttons reads as a broken app. The viewer variant is **Export only** —
the other controls are absent, not disabled.

### Viewers must not auto-generate — this is the same bug as the credits one

`canAutoStart` on all four pipeline screens has no role term. A viewer opening a shared
project whose current step is incomplete fires an editor-gated endpoint, gets 403, and lands
on an error state whose only control is **Retry** — which re-fires the same 403
(`ProjectScript:141-164`, `ProjectHooks:273-287`, `ProjectTitles:186-196`,
`ProjectPackaging:245-263`).

[Phase 07](./phase-07-frontend-account-switching.md) (checklist item 8) removes
generate-on-mount entirely, which fixes this too. **If Phase 09 somehow ships before that
removal, it must gate `canAutoStart` on the role.** Either way, viewers get a specific empty
state per step and **no Retry control**:

> **No script yet.** Nothing's been written for this video. Only editors can generate.

### Losing access mid-edit must not lose the text

`ProjectPackaging/index.tsx:178-180` and `ProjectTitles/index.tsx:151-162` auto-save typed
text that lives nowhere else. If a user is demoted while editing, every keystroke's save
403s and the work dies on the next navigation. A `role_forbidden` on a save path renders the
unsaved text in a copyable block:

> Your access to {channelName} changed while you were editing — copy your text before leaving.

---

## Member management screen

Owners get: the member list with roles, invite (choose a role, copy link), change a role,
remove a member, and transfer ownership.

Everything that changes membership goes through **one helper in one transaction**: read the
account document inside the transaction, compute all three fields in memory, write them
together. **`arrayUnion` / `arrayRemove` are forbidden here** — they are blind writes with
no conflict detection, so two concurrent demotions each seeing two owners would both commit
and leave the channel with none.

`memberUids`, `ownerUids` and `members` must never disagree. Never let a caller assemble
those three fields itself — a member who can query a channel but has no role is the failure
mode, and it's silent.

---

## Edge cases to handle explicitly

| Case | Behaviour |
|---|---|
| Removed from a channel while working in it | Next request 403s. The frontend clears the stale account and returns them to the channel list — it must not leave them on a dead screen. |
| Removed mid-stream (SSE) | The stream keeps running, and it is **not** read-only: the post-stream block writes the script, flips `isScriptGenerated`, links the resource, completes the step, and (after Phase 08) charges the billing owner — for up to 180s after removal. Probably acceptable; say what it actually does. |
| Last owner tries to leave | Refused, with a message telling them to transfer ownership first. |
| Invite accepted twice | Second attempt sees `status: accepted` inside the transaction and is refused. |
| Invite for an email that isn't the signer's | Refused. |
| Channel deleted while someone's inside it | Their next request 403s; same handling as removal. |
| Billing owner removed | Refused until billing is reassigned. |
| Last owner deletes their Firebase login directly | The client SDK can call `deleteUser()` without touching this API, so the block is bypassable. Needs an auth `onDelete` trigger that reconciles membership, or an explicit orphaned-account state. |

---

## Update the convention file in this commit

Add to `.claude/rules/api-design.md` in the same commit:

- The `/v1/invites` routes, flagging `GET /v1/invites/:token` as the second documented
  **unauthenticated** endpoint after `/v1/health` — the 43-char token is the secret. An
  undocumented auth exemption is the kind of thing a later reader "fixes".
- The role gate, stated by **effect rather than HTTP method**, since the two disagree here:
  `GET /v1/scripts/stream/:projectId` is editor because it generates, and `GET /v1/research/*`
  is editor because it burns project-wide YouTube quota a viewer could drain for every tenant.
  A rule written as "GET is safe for viewers" would be read as license to open both.

---

## How we'll know it worked

- A viewer sees content and can export, and every generate path returns 403 from the
  **server**, not just a hidden button.
- An editor can generate but not invite.
- The last owner cannot leave or demote themselves.
- An invite works once; the second attempt fails.
- A forwarded invite opened by the wrong email fails.
- Removing someone mid-session lands them somewhere sensible.

The server-side half of these is the important half. A hidden button is not a permission.

---

## Rollback

Stop issuing invites and remove the role guards; existing single-member channels keep
working. Any channel that already has multiple members would lose its access control, so
prefer fixing forward once this is live.

---

## Risks

**Trusting the UI.** The most likely mistake is enforcing a role only by hiding a button.
Every mutating route needs the server-side guard, and the extended auth-coverage test is
what keeps that true.

**Membership fields drifting apart.** Mitigated by the single transactional helper — and
only by that.
