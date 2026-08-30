---
title: "Phase 06b — Move Channel Context to the Account"
description: "Switch generation to read the channel's niche, competitors and website from the account instead of the user."
date: 2026-08-19
last_updated: 2026-08-30
status: "code-complete (backend) — frontend outstanding"
tags: ["multi-account", "phase-06b", "generation"]
---

# Phase 06b — Move Channel Context to the Account

## Where this stands (2026-08-30)

Backend done. Suite: 954 tests, 61 suites, green; `tsc` clean; `dist/` current.

**The four steps collapsed into one commit,** and that is a consequence of an earlier
decision rather than a shortcut. Dual-write → soak → re-sync → flip exists to carry
*existing data* across a *deploy*. There is no existing data (it is development data and
gets wiped before Phase 06 lands — see [phase-04](./phase-04-backfill.md)) and nothing is
deployed, so there is no window to protect. Writes and reads moved together.

| | |
|---|---|
| Step 1 — dual-write | **skipped**, deliberately: nothing to protect |
| Step 2 — re-sync migration | **skipped**, same reason |
| Step 3 — flip the six read sites | done |
| Step 4 — writes go to the account only | done |
| `AccountRepository.getContext` / `writeContext` | done, separate from `findById` |
| Per-channel completeness | done |

**`GET /v1/user/profile` keeps its shape.** Identity from `users/{uid}`, the channel half
from the active account, merged into the response the frontend already parses. The doc left
this open; merging is what keeps all five frontend consumers working unchanged, and two of
them fail *silently* if channel fields disappear — `EnrichNudge` shows permanently, and
`selectIsOnboarded` routes every user back to onboarding.

**Still outstanding, and it is the frontend half.** Nothing in `momentumx-fe` sends
`X-Account-Id` yet, so every one of these reads and writes resolves to the fallback channel.
The per-channel behaviour is real on the server and invisible until Phase 07 ships the
switcher. `stats.ideas/scripts` also still live on the user record, so the dashboard counts
remain per-user rather than per-channel — Phase 08 territory, noted here because the doc's
consumer table lists it.

---

**Size:** medium — seven read sites, two write sites, one dual-write window.
**Depends on:** Phase 06a. Its acceptance test needs one user with **two** channels, which
requires the create-account endpoint — an earlier draft depended on Phase 06 alone and was
therefore unverifiable.
**Blocks:** Phase 07. **This is a hard gate — do not open the one-way door without it.**
**Note:** step 4 is a second, quieter door of its own. See Rollback.

> This phase was missing from the first draft of the plan. Two independent reviews found
> the same gap, and it is the difference between multi-account being real and being
> cosmetic.

---

## The problem in simple English

Phases 03–06 make sure every **stored document** knows which channel it belongs to. Your
ideas, scripts and packaging are correctly separated.

But the AI doesn't generate from stored documents — it generates from **who you are**:
your niche, your target audience, your brand name, your competitors, your website text,
your top-performing titles. All of that is still read from `users/{uid}`.

Phase 03 copies those fields onto the account once, when the account is created, and then
nothing keeps them in step. Nothing ever switches the *reads*.

So without this phase, after Phase 07 you would get:

- Channel A: cooking. Channel B: personal finance.
- Switch to B, generate ideas → the prompt is built from **A's** niche, A's competitors,
  A's website text.
- The ideas are saved correctly against B, with the right `accountId`, and they are
  **cooking ideas**.

No error. No failed test. The `accountId` on every document is perfectly correct. The
failure looks like "the AI got worse", and nobody traces that to a deploy.

---

## Where the channel is read today

Every one of these must move from the user record to the active account:

| File | What it reads | Feeds |
|---|---|---|
| `content.service.ts` (idea prompt) | `brandName`, `targetAudience`, `competitors`, `niche`, `websiteContent` | Idea generation |
| `content.service.ts` (`generateIdeas`) | the user record | Idea generation |
| `content.service.ts` (script paths, ×2) | the user record, `format` | Script generation and regeneration |
| `context.service.ts` | the whole user record | **Hooks, title and packaging** — this one assembles the channel context object every one of those steps uses |
| `research.service.ts` | `niche` | Trending research |
| `research.service.ts` | `competitors` | Competitor research |

`context.service.ts` is the important one. It builds the object that `buildCreatorContextBlock`
turns into the "about this creator" block in the hooks, title and packaging prompts. One
change there covers three pipeline steps.

## Where the channel is written today

| File | What it writes |
|---|---|
| `user.service.ts` → `createOnboardingData` | the onboarding fields |
| `user.service.ts` → `updateProfile` | Settings edits |
| `user.service.ts` → `refreshContext` | re-scraped channel and website data |

---

## What we'll do

### Step 1 — Dual-write

Change the three write paths to write **both** the user record and
`accounts/{req.accountId}/context/channel`. Reads stay on the user record.

This closes a window nobody would otherwise notice: between Phase 03 (which snapshots the
fields onto the account) and this phase, **any profile edit updates only the user record**.
Those edits would be silently lost the moment reads flip. Dual-writing first means the
account copy is current before anything depends on it.

Let it soak. A few days of real edits is enough.

### Step 2 — Re-sync

Re-copy the channel fields from `users/{uid}` to `accounts/{uid}/context/channel` for every
account created before dual-writing started. Same shape as the Phase 04 backfill and far
smaller — one document per user.

This is what repairs anyone who edited their profile during the window.

### Step 3 — Flip the reads

Point all seven read sites at `accounts/{req.accountId}/context/channel`, via
`AccountRepository.getContext(accountId)` replacing `userRepo.get(userId)` — the services
already take `userId` everywhere, so this is mostly threading `accountId` through the same
call chain Phase 06 already touched.

**Two repository methods, deliberately.** `AccountRepository.get(accountId)` returns the
account document (membership, roles, billing owner) and is what `accountMiddleware` calls
on every request. `getContext(accountId)` returns the context document and is what
generation calls. They are separate because the permission path and the generation path
want different data — collapsing them into one method is how the scraped blob ends up back
on the hot document.

Read count is unchanged by the split: these seven sites read exactly one document today
(`users/{uid}`) and exactly one after (`.../context/channel`).

### Step 4 — Retarget the writes

Onboarding, profile update and refresh-context write **only** the account. Stop
dual-writing.

At this point `users/{uid}` holds identity and nothing else, and
[Phase 10](./phase-10-cleanup.md) can safely delete the leftover fields.

---

## Don't forget

**`purpose` and `description`** are channel fields persisted on the user record by
`createOnboardingData`, and they were missing from the account schema in Phase 02 and from
the removal list in Phase 10. Add them to `accounts/{accountId}/context/channel`.

**Profile completeness.** `getProfile` returns a completeness score computed from the
channel fields. Once those live on the account, that score must be computed from the
account or it reports zero for everyone. It's per-channel now, which is more useful
anyway — "this channel is 60% set up".

**`GET /v1/user/profile` changes shape.** It currently returns identity *and* channel
fields merged. Decide whether it keeps returning the active channel's fields for
convenience, or whether the frontend fetches the account separately.

**Correction to an earlier draft: the frontend user slice is not its only consumer.** The
slice is the only *fetcher*; the channel half is read directly by five places, and each
breaks differently:

| Consumer | Reads | What breaks |
|---|---|---|
| `sideDrawer/index.tsx:43,75,86` | `user.userName` → `@handle`, avatar initial | Phase 10 deletes `userName` → name over a bare `@` |
| `Settings/index.tsx:37-41,112-116` | the whole channel form + `completeness` | edits the wrong record, or reports 0% |
| `Dashboard/index.tsx:23,92-96` | `stats.ideas/scripts/credits` | renders `0` / `"FREE"` per channel |
| `EnrichNudge.tsx:32` | `incomplete = !user?.niche \|\| !user?.targetAudience` | on an identity-only user record `incomplete` is always true → the nudge shows permanently, for everyone |
| `user.slice.ts:110-114` | `selectIsOnboarded` — `userName \|\| (niche && targetAudience)` | **the routing gate** — every user is sent to onboarding, or none are |

The last one is load-bearing: Phase 07 already requires that gate to move to the active
account. These two statements should be read together, not as separate tasks.

`EnrichNudge` is the one most likely to be missed, and it is the sharp end of this phase:
it *writes* niche and audience. If it still reads the user record after step 4, a single
Save on channel B writes channel A's identity onto B — which is precisely the failure this
phase exists to prevent, arriving through the front door.

---

## How we'll know it worked

The test that matters is end-to-end and manual, because it's about content rather than
status codes:

1. Set up channel A with a distinctive niche — "sourdough baking".
2. Set up channel B with an unrelated one — "index fund investing".
3. Switch to B and generate ideas.
4. **They must be about investing.** If any of them mention bread, this phase isn't done.

Repeat for a script, hooks, a title and a packaging description — each reads channel
context through a different path, and `context.service.ts` covers three of them at once.

Also verify: edit the niche in Settings on channel B, regenerate, and confirm the new
niche is used. That proves the write path retargeted too.

---

## Rollback

Steps 1 and 2 are additive — dual-writing and re-copying change nothing that's read.

Step 3 is a normal code revert while the user record still holds the fields (Phase 10
hasn't deleted them yet). This is exactly why Phase 10 waits.

**Step 4 is a door, and it is not labelled as one anywhere else in this plan.** Once writes
stop hitting `users/{uid}`, that record freezes. Reverting after step 4 silently serves
channel context that is stale by however long step 4 has been live — the same silent
wrongness this phase exists to prevent, with the same absence of any error.

**Therefore: write and test the reverse re-sync script (account → user) BEFORE step 4
ships.** Not after a revert is needed. It is the same copy as step 2 with the source and
destination swapped, so it costs almost nothing to write while step 2 is fresh — and it is
unwritable under pressure, at the moment you need it, with a production incident open.

Treat "reverse re-sync exists and has been run once against a scratch account" as an
acceptance item for step 4, alongside the content checks above.

**STATUS: step 4 shipped without it, and this item is now void rather than outstanding.**
The four steps collapsed into one commit because the wipe decision removed what they were
protecting: there is no existing data to carry and nothing is deployed, so there is no
window in which `users/{uid}` holds anything worth re-syncing back to. A reverse re-sync
would copy empty fields over a live channel context — the failure it was written to
prevent, inverted. What replaces it is the wipe itself: the six content collections are
cleared before this deploys, so no record predates the account model.

If data ever exists on both sides again, this item comes back.

---

## Risks

**The failure is silent and looks like model quality.** There is no exception, no failed
request, and no test that would catch it — only content that is subtly about the wrong
subject. That is why the acceptance check above is deliberately about *what the AI wrote*,
not about whether the endpoint returned 200.

**Missing one read site** produces the same silent wrongness for one pipeline step only —
for example, correct ideas but hooks written for the other channel.

**Use the right grep.** An earlier draft said "grep for `userRepo.get` across
`src/service/`" and called the table definitive. That grep **cannot** find the two sites in
`UserService`, because that class names the field `repo`, not `userRepo`
(`src/service/user.service.ts:22`):

- `user.service.ts:93` — `getProfile`, which feeds `computeProfileCompleteness`. All eight
  scored fields in `src/utlils/profile.ts` are channel fields, so the "reports zero for
  everyone" prediction above is exactly right.
- `user.service.ts:118` — `refreshContext`, which reads `users/{uid}` to rebuild the
  enrichment inputs and re-writes them. This one is listed under *writes* in this document
  but not under reads. After step 4 it would read the user record and write the account;
  after Phase 10 deletes those fields it would silently re-enrich from nothing and
  **overwrite good account data**.

The grep that works:

```bash
grep -rnE "\.repo\.get\(|userRepo\.get\(" src/service/
```
