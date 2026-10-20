---
title: "Phase 08 — Credits and Metering"
description: "One credit balance with a price list, replacing the separate stats counters."
date: 2026-08-19
last_updated: 2026-09-26
status: "locally accepted — deployment not performed"
tags: ["multi-account", "phase-08", "billing"]
---

# Phase 08 — Credits and Metering

## Local acceptance and rollout boundary

Frontend acceptance is complete locally: 174 tests in 24 files, including mounted
pipeline/lifecycle coverage and stream HTTP/domain-error handling; build passes and
lint has zero errors (three existing warnings). The balance/402 states and refund
messaging distinguish disabled enforcement, unknown balance and verified refunds.
`VITE_SUPPORT_EMAIL` optionally enables the support link; without it no contact link
is invented. Backend final persistence-fencing and malformed-balance validation pass: **1,243 tests
in 75 suites**, including 35 independent adversarial acceptance checks. Full evidence is
recorded in [operational readiness](./operational-readiness.md). No deployment or
allowance provisioning was performed.

## Implementation decisions — 2026-09-26

The user chose **enforcement disabled until configured**, then delegated pricing with
"Decide something and keep it configurable." These decisions supersede the contradictory
bundle/pricing and unconditional-enforcement language in the historical design below.

- **Packaging is per item:** description 2, thumbnail 1, shorts 1 (total 4). Only the failed
  item refunds and retries. There is no composite packaging charge or bundle endpoint.
- Defaults: ideas 3, script 5, hooks 1, title 1, description 2, thumbnail 1, shorts 1.
  Override each with `CREDIT_COST_<KIND>` (for example `CREDIT_COST_SCRIPT=8`). Values must be
  nonnegative safe integers; invalid prices fail startup. Prefill always remains free.
- Set `MONTHLY_CREDIT_ALLOWANCE` to a nonnegative integer to enable monthly enforcement for
  a billing owner. New records use `allowanceSource:"default"` and follow configuration;
  an explicit `allowanceOverride` sets a per-owner quota. Legacy manually provisioned
  `allowance` values remain overrides until marked `allowanceSource:"default"`.
  No configured allowance means `enabled:false`, `allowance:null`, `remaining:null`:
  generation remains available, with transactional locks and channel usage reporting.
  Zero is an enabled, exhausted allowance. Invalid configuration and database errors fail
  closed. Existing lifetime counters are never converted into consumption.
- `GET /v1/billing` returns the standard success envelope with `data` containing `enabled`,
  `allowance`, `consumed`, `remaining`, `periodStart` (`YYYY-MM` UTC),
  `resetsAt` (ISO UTC), and `costs`. HTTP 402 uses `insufficient_credits`, with the same balance
  fields and `required` in `detail`. Channel usage counts nominal credit cost even while
  enforcement is disabled; it is reporting, not a debit.
- Reservation atomically validates membership, role, step preconditions and the generation
  lock, and holds available credits. Successful settlement charges consumed credits after
  content persistence; failures release the hold without charging. Expired locks permit
  reservation recovery. Generation and billing persistence remain separate transactions.
- Every durable generation write re-checks membership, role and the current project
  generation token inside its persistence transaction; an expired runner cannot overwrite
  a successor even if its model result arrives late.
- Confirmed uncharged failures expose `detail.charged:false`. SSE reports structured
  generation errors followed by `[DONE]`; pre-stream refusals retain HTTP status/JSON.
  If settlement fails after content persistence, output can remain saved but uncharged;
  the runner logs the failure. This is not an atomic content-and-payment ledger.
- Public YouTube requests use a six-hour cache: local promises coalesce requests; 256
  hash-addressed Firestore slots share results across instances. Each slot checks the full
  query hash and expiry, so collisions only lower hit rate. API keys are excluded from stored
  keys; private channel context is never cached here. No TTL service/scheduler is required.

Paid reservations have no 256-receipt ceiling; expired locks allow stale holds to be
recovered. Noncharged usage receipts are bounded to 256 and evict an entry to keep free
runs available (not guaranteed chronological eviction). A sufficiently old free run whose
receipt and lock have both disappeared cannot contribute usage when it finally settles.
Purchased credits would need a durable recovery ledger beyond this monthly allowance model.
Configuration and Google quota changes remain operator actions.


**Size:** medium.
**Depends on:** Phase 01b (the generation seam) and Phase 06. Phase 01b is a hard
dependency, not a nicety — see "Where the charge goes" below. Independent of Phase 07 in
principle, but see precondition 1 — generate-on-mount must be gone first, and that is
frontend work.

> ## ⚠️ Two hard preconditions
>
> **1. Generate-on-mount must already be gone.** All four pipeline screens generate on
> arrival with no click — `momentumx-fe/src/pages/ProjectScript/index.tsx:93-98`,
> `ProjectHooks/index.tsx:143-150`, `ProjectTitles/index.tsx:76-84`,
> `ProjectPackaging/index.tsx:150-162`. Ship metering before it is removed and **clicking a
> project card spends credits.**
>
> **This is [Phase 07](./phase-07-frontend-account-switching.md)'s checklist item 8, not
> work this phase does** — Phase 07 needs it removed for a reason that has nothing to do with
> money (after a switch, a mounted screen auto-generates into the *new* channel, persisting a
> real document in the wrong place), and Phase 07 ships first. The replacement mechanism is
> specified there. This phase only verifies it: if any `autoStartedRef` effect still exists
> when the debit lands, the charge fires on navigation.
>
> **2. The debit cannot go where the original draft put it.** Every `startStep` call site
> swallows its own failure, and four of the twelve generation paths generate *before* they
> transition the step. Phase 01b is what makes a gate possible at all.

**Resolved:** credits are a **monthly allowance that resets**, not a lifetime balance.
The reset is **lazy** — computed inside the debit transaction when `periodStart` is stale.
A scheduled reset is **forbidden**: Cloud Scheduler is Blaze-only, and on a downgrade it
would silently stop firing, pinning every user at last period's `consumed` and hard-blocking
generation with no error that points at the cause. See the README's downgrade traps.

---

## The idea in simple English

Today there are three separate counters on the user record — `stats.ideas`,
`stats.scripts`, `stats.credits` — and they only count. Nothing stops anyone doing
anything.

This phase replaces them with **one credit balance and a price list**. A script costs more
than a thumbnail brief. Each channel names a **billing owner**, and everything anyone does
in that channel comes out of that person's balance.

So a freelancer working across three clients' channels spends the clients' credits, not
their own. And a client can't multiply their free allowance by adding channels, because
allowance lives with the person, not the channel.

---

## Where the numbers live

Three separate things, deliberately:

```
billing/{uid}
  periodStart, allowance, consumed          ← the balance that gates access

accounts/{accountId}/usage/{YYYY-MM}
  ideas, scripts, hooks, packaging, credits ← reporting only, per channel

accounts/{accountId}.billingOwnerUid        ← whose balance this channel spends
```

**Why the balance isn't on `users/{uid}`:** that record is read on nearly every request.
Making it the hot write target for every generation puts profile reads in contention with
generation writes for no benefit. Give it its own document.

**Why usage is month-keyed:** writes spread naturally across documents instead of hammering
one, and "what did this channel cost in July?" is a single read.

**Multiple owners:** `billingOwnerUid` is an explicit single field, so "who pays" is never
ambiguous even when an account has several owners. Needs a rule for when that person is
removed or demoted — the sensible default is to block the removal until billing is
reassigned, matching the "can't delete your last owner" rule.

---

## Charging correctly

### Check and consume in one transaction

Reading a balance, deciding it's sufficient, and decrementing it must be **one Firestore
transaction**. Two generations starting at once would otherwise both read the same balance
and both proceed.

```
runTransaction:
  balance = billing/{billingOwnerUid}
  if balance.periodStart < thisMonth:            // lazy reset — no scheduler
      balance = { periodStart: thisMonth, consumed: 0, allowance: planQuota }
  if balance.consumed + cost > balance.allowance → throw PaymentRequired
  balance.consumed += cost
```

`FieldValue.increment` would be **wrong** here and this plan deliberately doesn't use it:
`increment` is a blind write with no read, so it cannot enforce "if sufficient".

### Where the charge goes — the seam, not `startStep`

An earlier draft proposed putting the debit inside `startStep`'s transaction. **That does
not work, and tracing it is what produced Phase 01b.** Three reasons, all verifiable:

1. **Every `startStep` call swallows its own failure.** `content.service.ts:287-291` and
   `hooks.service.ts:93-97` are `try { await startStep(...) } catch { console.error(...) }`
   and generation proceeds regardless. A thrown `PaymentRequired` would be swallowed exactly
   like a lock conflict, and the Gemini call would run anyway.
2. **Packaging generates before it locks.** `packaging.service.ts:174-179` calls `runTitle`
   — the model call — *first*, then `persistGeneratedItem`, which is where `startStep` lives
   (`:248`). Debiting there charges for content already generated and already written.
3. **The regenerate paths mostly have no lock to attach to.** `hooks.service.ts:169-207`,
   `content.service.ts:478-529` and `packaging.service.ts:503-659` go straight to generation.
   (`regenerateItem` *does* call `startStep` at `:638`, but only after generating, to repair
   a stuck step — it is not a lock.)

So the debit goes in **`StepRunner.run`** (Phase 01b), which is the one place every model
call passes through, always before the call, and whose failures are deliberately *not*
swallowed. In that design it is two lines — one in the try, one in the catch.

### Debit before, refund on failure — and one path where "failure" isn't a throw

Charge **before** the Gemini call, and add the credits back if it fails. Charging after
success means a client that disconnects mid-stream — which the script route makes easy —
gets the work for free.

**The empty-stream case is not a throw today.** `content.service.ts:324-328` logs
`script_stream_empty`, calls `abandonStep`, and **returns normally** with an empty string.
A refund-on-throw wrapper would never fire, so a failed 5-credit script generation — the most
expensive item on the price list — would charge full price. Phase 01b makes that path throw
`ServiceUnavailable` after `[DONE]` has already been written, which is what lets the runner
refund it.

**Cold starts count as failures.** The SSE route is served by Render, which spins down after
~15 minutes idle; a cold connection can fail before a single byte arrives (see Phase 07).
A stream that delivered nothing must not be charged.

**Prefer idempotency over trusting the refund.** Script generation is *already* idempotent —
`content.service.ts:243-253` replays an existing script rather than regenerating when
`project.scriptId` is set. Key the script charge on `(projectId, scriptId)` so a retry is
free rather than relying on a compensating write that runs on a host that may be cold or
gone. Cheaper than the refund path and correct under retry.

### Why there is no ledger

A reservation ledger (`billing/{uid}/ledger/{operationId}`) was considered and rejected.
With a monthly reset, a stranded debit self-heals in at most 30 days — that turns "the user
permanently loses credits" into "the user is slightly short until the 1st", which does not
justify a subcollection, an operation-id scheme and expiry reconciliation. There is also no
Cloud Scheduler under Spark to reconcile with.

Add it when top-ups exist, because then a stranded debit becomes a refund request.

```
// ponytail: no ledger — monthly reset bounds a stranded debit to 30 days.
// Add billing/{uid}/ledger/{opId} when top-ups make it a real refund request.
```

The double-charge risk does **not** self-heal, and is handled structurally instead: the debit
lives in the same transaction as the lock (Phase 01b), so you cannot charge twice because you
cannot start twice.

### The current pattern is not adequate

`content.service.ts` increments `stats.ideas` with a **floating, unawaited** promise. On
serverless the process can be frozen after the response and the write never lands. Two
other sites do `await`. That inconsistency is fine for a vanity counter and disqualifying
for something that gates access.

All counter writes become awaited transactions. And they must use
`set(..., { merge: true })`, not `.update()`, which throws when the document doesn't exist
— see Phase 01, item 2.

### Don't build sharded counters

The usual advice about Firestore's ~1 write/second per document doesn't bite here: a
generation takes several seconds, so even ten simultaneous editors in one channel produce
about two writes per second, against a per-channel document. Sharding would also make
check-and-consume impossible — you can't compare a balance you'd have to reassemble from
shards.

---

## The price list

In `src/constants/` next to the other constants, so pricing changes don't touch schema:

```ts
export const CREDIT_COSTS: Record<GenerationKind, number> = {
  ideas: 3,          // 10 ideas + embeddings + research
  script: 5,         // the longest generation
  hooks: 1,
  title: 1,
  description: 2,    // was a single `packaging: 4` — see below
  thumbnail: 1,
  shorts: 1,
  prefill: 0,        // onboarding; free, but still traced
} as const;
```

**This literal did not compile against the shipped union**, and the phase's own safety
argument — "the type makes it a compile error" — fired against the phase itself. Phase 01b
shipped `GenerationKind` with `description | thumbnail | shorts` as three separate kinds
and no `packaging` member (`src/constants/pipeline.ts`), because they are three independent
unlocked generations with no shared `KIND_STEP` entry. So the "charge packaging once, not
three times" decision below has **nowhere to attach**: the seam never sees a single
`packaging` generation. Either price the three separately (as above) or give Phase 01b a
composite kind first — but decide it before writing the debit, not after.

Keyed on `GenerationKind` from `src/constants/pipeline.ts` (Phase 01b) so a new generation
kind cannot be added without a price — the type makes it a compile error.

Numbers are placeholders — set them against real cost. Note that **research is the expensive
part**, not Gemini. See below.

### Charge packaging once, not three times

`ProjectPackaging` fires description, thumbnail and shorts **concurrently**
(`packaging.service.ts:174-210` via the frontend's `Promise.all`). Three separate debits
means three transactions contending on one `billing/{uid}` document, and each retry is
latency on a screen that is already generating.

Charging the packaging *step* once, at 4 credits, removes the contention entirely and
matches how the step actually completes — `upsertGeneratedItem` auto-completes when all three
items exist.

**But this has a UI consequence that must ship with it.** `ProjectPackaging` renders three
independent per-card error states (`ProjectPackaging/index.tsx:438-486`). With a single
step-level charge, a partial model failure is a *whole-step* failure to refund and retry — so
the screen needs **one step-level error state above the cards**, and the recovery control
becomes **"Retry the failed item"** rather than "Regenerate All", which would re-charge the
batch. Without that, a user retries one item against a charge that already covered all three.

Contention ceiling worth knowing: the balance is per **billing owner**, not per account, so
an agency owner funding ten channels concentrates ten channels' write rate on one document.
Still comfortably under Firestore's ~1 write/sec sustained guidance given multi-second
generations, but that is where sharding would eventually be needed.

### Never credit-gate a save

`POST /v1/packaging/save`, `PATCH /v1/scripts/edit/:scriptId`,
`PATCH /v1/ideas/edit/:ideaId` and `POST /v1/packaging/:id/select-title` are **role-gated
only**. `ProjectPackaging/index.tsx:178-180` and `ProjectTitles/index.tsx:151-162` auto-save
typed text that exists nowhere else; a credit refusal on that path is a data-loss bug wearing
a billing costume.

### Migrating the existing counters

**DECIDED 2026-08-25: start everyone fresh.** Every existing user begins with a full
allowance; lifetime `stats.ideas` / `stats.scripts` are NOT converted into consumed credits.

The rejected alternative was converting history through the price list so heavy users start
partly consumed. It is defensible arithmetic and the wrong product call: the users it
penalises hardest are the most engaged ones, and they would open the app to find a balance
they had already spent without ever being told it existed.

`stats.*` stays where it is as lifetime analytics — it is simply not an input to billing.

Note that the Cloud Function seeds `stats` on sign-up
(`functions/src/util/index.ts`) and must be updated in the same release — it's a separate
deploy artifact and easy to forget.

### What this phase does not cover: how credits are bought

This document specifies how a balance is *spent* and never how it is *topped up*. That half
lives in `implementation-phases.md` Phase 5A, which is now marked superseded **except for
5A and 5D** — those are the surviving pieces, not duplicates of anything here.

Carry these forward when the purchase path is built:

- The webhook route **must bypass `authMiddleware`** (a payment provider has no Firebase
  token) and needs the **raw body** for signature verification. `express.json()` is applied
  globally at `app.ts:22`, so the raw parser has to be mounted before it. Both are classic
  payment-integration bugs; integration-test them with the provider's CLI fixtures.
- The in-memory rate limiter has to be replaced before quota enforcement rests on it — it
  resets per serverless instance. [Phase 05](./phase-05-account-context-api.md) adds a second
  reason: per-IP limits punish several members of one shared channel in one office.

Until that path exists, `allowance` is set by hand or by plan tier, and nothing in this
phase depends on a provider being wired.

### Fail closed, and why the older plan's fear doesn't apply

`implementation-phases.md` Phase 5 required enforcement to **fail open** on infrastructure
errors, reasoning that a Firestore blip must not lock every user out of generation. This
phase fails **closed**, and the reason is that the two systems share fate: the debit is a
Firestore transaction, and so is persisting whatever gets generated. If Firestore is
unavailable, generation is already broken. Failing closed costs nothing that was not already
lost; failing open hands out paid product on every blip.

State this in the code where the transaction throws, because "don't lock users out" is a
persuasive-sounding argument that will otherwise get this reverted by someone reading the
older document.

---

## The finding that matters more than credits

**Your real constraint is YouTube API quota, not Gemini cost, and it is much closer than
you think.**

`search.list` costs **100 quota units**; the default daily quota is **10,000 units for the
whole project**, not per user.

There are **four** `search.list` call sites, across **two** files — an earlier draft named
only the first three:

| Site | Called from |
|---|---|
| `research.repository.ts` — trending | idea generation, `GET /v1/research/trending` |
| `research.repository.ts` — keyword signals | idea generation, `GET /v1/research/keywords` |
| `research.repository.ts` — competitor top-videos | `GET /v1/research/competitors`, once **per competitor**, uncached, per request |
| **`extract.repository.ts:8`** — `getYTChanelTitles` | `formatUserData` → `resolveChannel`, on `PATCH /v1/user/onboarding` **and** `POST /v1/user/refresh-context` |

One idea generation ≈ 100 + 100 + 1 = **201 units** — roughly **50 idea generations per day
across your entire user base.** Title generation adds ~200 per call.

**Adding a channel is the expensive one, and it was not counted at all.** `formatUserData`
calls `resolveChannel` once for the user's own channel **and once per competitor**, and each
resolution costs ~1 unit (`channels.list`) + 100 (`search.list`) ≈ **101 units**. So
onboarding a channel with three competitors ≈ **404 units** — about **24 channel setups per
day for the entire product**, a tighter ceiling than idea generation. The frontend also fires
`refresh-context` in the background right after onboarding, so this can run twice.

**Phase 07 turns "add a channel" into a routine action.** That makes this the quota line item
most directly multiplied by multi-account.

**Fixes, in order:**

1. **Cache research by niche.** Trending videos for "AI automation" are identical for every
   user in that niche and are re-fetched per request. A few hours' TTL serves many users from
   one call. *This does not help the channel-enrichment path* — that is per-channel, not
   per-niche, and needs its own cache keyed on `channelId`.
2. **Cache channel enrichment on `channelId`**, which also makes `refresh-context` cheap.
3. **Request a quota increase from Google.** Given the arithmetic above, treat this as a
   prerequisite for Phase 07 rather than a Phase 08 nicety.
4. Then consider metering research separately from generation.

Items 1 and 2 are worth doing **regardless of multi-account** — same work, many more users.

---

## The frontend half

The original draft had none, and metering has a UI surface today that would break silently.

**Delete the "Available Credit" card.** `Dashboard/index.tsx:95` renders
`stats?.credits?.toString() ?? "FREE"` into a card labelled "Available Credit"
(`constants/dashboard/index.tsx:20-25`). This phase moves the balance to `billing/{uid}`, so
on release day that card reads **"FREE"** while every generation returns
`insufficient_credits`. The two neighbouring cards (`stats.ideas`, `stats.scripts`) are
lifetime vanity counters fed by the same record and would read `0` per channel forever —
drop all three and let the dashboard be projects.

**Put the balance in the sidebar footer**, above the avatar row
(`sideDrawer/index.tsx:71-90`). It is on every screen, next to where the switcher is going,
and next to the *person* — which is correct, because with `billingOwnerUid` the balance
belongs to a person, not to the channel they are currently in.

```
12 of 50 credits · resets 1 Sep          (amber at ≤20%)
Out of credits · resets 1 Sep            (at zero)
```

**Cost goes on the button that already exists.** Generation is triggered by the forward CTA
on the *previous* screen — `IdeaCard.tsx:114` "Use Idea", `ProjectScript/index.tsx:322`
"Continue to Hooks", `ProjectHooks/index.tsx:243,436` "Continue to Titles",
`ProjectTitles/index.tsx:295` "Continue to Packaging". Auto-start never removed a click; it
moved it there and hid the price. So put the price there:

> **Generate hooks · 1 credit →**

…when the next step is empty, and leave the plain "Continue to …" label when it already has
content. Same for the four empty-state buttons, which already exist
(`ProjectPackaging:289-315`, `ProjectTitles:199-230`, `ProjectHooks:290-316`).

**No payment confirm.** Price on the button is disclosure. A dialog on every spend trains
people to click through it, and with a monthly reset a mis-spend costs hours, not money.
`ConfirmDialog` stays reserved for its existing contract — interrupting when authored work is
about to be lost.

**Generate-on-mount is already gone** — removed in Phase 07 (checklist item 8), where the
`{ state: { run: true } }` replacement is specified. Nothing to do here beyond confirming it:
grep for `autoStartedRef` and expect no hits before the debit ships.

**Exhausted state, inline under the disabled button** — not a toast, not a modal:

> You've used all 50 credits this month. They reset on **1 September**. Everything you've
> already made stays here and exports as normal.

That last clause matters: with a monthly reset the correct message is *come back*, not *pay
us*, and export genuinely still works.

**"Top-up prompt" with no payments integration:** there is no top-up, so don't build a fake
one. One secondary `mailto:` link with the uid prefilled.

**Refunds must be visible.** Refetch the balance on every settle, success or failure, and
append *"Not charged."* to a refunded failure's error line. Otherwise a user who fails three
script generations counts 15 credits gone with no evidence otherwise.

---

## How we'll know it worked

- A user at zero credits is refused with a clear message naming the reset date, not a crash.
- Two simultaneous generations can't both spend the last credit.
- A failed generation refunds — **including** a script stream that produced nothing, and one
  that failed on a cold Render connection before any byte arrived.
- **Navigating to a project charges nothing.** Open every pipeline screen by dashboard card,
  deep link and refresh; the balance is unchanged.
- Retrying an idempotent script generation charges once, not twice.
- Packaging charges its independent items at configured prices (defaults 2+1+1); retry only recharges the failed item.
- Per-channel usage matches the sum of the actions taken.
- A user with no `billing/{uid}` document gets one created rather than an error.
- A viewer cannot spend the billing owner's credits (Phase 09 — but assert it here too).

---

## Rollback

Remove the enforcement check but keep writing counters. The balance documents are inert
without the gate, so nothing is lost by reverting.

---

## Risks

**Blocking paying users through a bug** is the worst outcome here. Consider a soft launch:
count and log what *would* have been refused, without refusing it, until the numbers look
right.

**Users with no user record** (Phase 01, item 2) would be hard-blocked once credits gate
generation. That fix is a genuine prerequisite, not a nice-to-have.
