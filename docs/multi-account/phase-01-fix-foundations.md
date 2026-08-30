---
title: "Phase 01 — Fix Foundations"
description: "Repair the bugs that make a safe tenancy migration impossible, before any of it starts."
date: 2026-08-19
last_updated: 2026-08-26
status: "complete"
tags: ["multi-account", "phase-01", "correctness"]
---

# Phase 01 — Fix Foundations

**Size:** medium — six focused fixes, all in existing code.
**Depends on:** nothing.
**Blocks:** Phase 01b (item 3), Phase 04 (item 1) and Phase 08 (items 1 and 3). Item 6 is
independently exploitable today and should not wait for any of them.

---

## Why this phase exists

Some existing bugs are harmless with one user per channel and become real the moment
there are two, or the moment a migration script walks the whole database. Fixing them
first is cheaper than fixing them while also changing tenancy, and it means the migration
isn't built on sand.

---

## 1. Records can be written with no owner

**Where:** `src/utlils/content.ts` — `formatGeneratedTitle()` sets `createdBy: userId || ""`,
and `formatGeneratedIdea()` spreads its result. `formatGeneratedScript()` does the same.

**Note:** `formatGeneratedTitle` is *also* called directly on the bring-your-own-title path
(`video-project.service.ts` → `createFromTitle`), so fixing only `formatGeneratedIdea`
misses a live write site.

**In simple English:** if `userId` is ever empty, the record is saved with an owner of
`""` — an empty string. It isn't missing, it's a *real value*, and every such record
across every user collides on the same one.

**Why it matters now:** the backfill in Phase 04 copies `createdBy` into `accountId`. An
empty owner becomes an empty account id, which would put unrelated users' orphaned
records into one shared bucket. That is a data-mixing bug, and it would look like a
tenancy leak.

**Fix:** validate at the **service entry**, not inside the formatter. `regenerateAll`
(`content.service.ts:401`) archives the previous batch *before* formatting (`:412-420`), and
`Promise.allSettled` then silently drops rejected results — so a throw inside the formatter
would archive the old ideas and save zero new ones, returning 200. That trades a bad write
for silent data loss.

Guard where `userId` arrives (it is already set by `authMiddleware`), and separately log
the dropped results from the `allSettled` filter, which currently discards failures without
a trace. **There are two such drop sites, not one** — `content.service.ts:416-420` and
`idea.controller.ts:55-62`.

**Two counts to run**, both feeding Phase 04:

1. Records where `createdBy` is `""` — the quarantine path (see Phase 04, "orphans").
2. Records where `createdBy` is **absent entirely**. This is a different number and the
   original draft missed it. `src/config/firebase.ts:19` sets
   `ignoreUndefinedProperties: true`, so a write derived from a missing field is silently
   dropped rather than erroring — the record stays untagged while the backfill counts it as
   patched. The measurement script in the README computes both.

**Note the other unguarded write sites.** This item fixes `createdBy: userId || ""` in
`src/utlils/content.ts:24` and `:62`. Five more sites set `createdBy: userId` with no guard
at all — `packaging.repository.ts:116`, `video-project.service.ts:59`,
`hooks.service.ts:123`, `packaging.service.ts:385`, and `event.service.ts:21`. With
`ignoreUndefinedProperties` on, an undefined `userId` there produces a document with **no**
`createdBy` field rather than an empty one, which is exactly what count 2 above measures.

---

## 2. New users can end up with no profile record at all

**Where:** `functions/src/index.ts` — the `onCreateUser` auth trigger.

**In simple English:** when someone signs up, a Cloud Function writes their user record.
But it doesn't `return` or `await` the write. In a background Cloud Function, work that
isn't returned can be dropped when the instance is frozen after the function returns. So
the record sometimes never gets written. The surrounding `try/catch` can't help — it
never holds the promise, so there's nothing for it to catch.

Two follow-on problems:

- `UserRepository.update()` (`src/repository/user.repository.ts`) uses Firestore's
  `.update()`, which **throws if the document doesn't exist**. Any code incrementing a
  counter on a missing user fails.
- Phase 08 makes credits gate generation. A user with no record has no balance, and would
  be hard-blocked from using the product with no way to self-repair.

**Fix, three parts:**

1. `return` the promise from the trigger so the platform waits for it.
2. Use `.set(data, { merge: true })` instead of `.set(data)` so it can't clobber a record
   that already exists (the API may have created one first).
3. Make counter writes use `set(..., { merge: true })` rather than `.update()`, so a
   missing record self-heals instead of throwing.

**Note:** `functions/` is a **separate deploy artifact with its own copy of the
collection names** (`functions/src/util/index.ts`). It has already drifted — it's missing
`EVENTS`. Whatever changes here must be deployed as functions, not just as the API.

---

## 3. Read-then-write operations that break with two editors

Three places read a document, compute a new value in memory, and write it back. With one
person that's a millisecond gap nobody hits. With two editors in a shared channel — the
entire point of this project — one person's work silently overwrites the other's.

| Where | What goes wrong |
|---|---|
| `packaging.repository.ts` → `markStale()` and `clearStale()` | Both rewrite the **whole** `itemStatuses` map. If a regenerate completes in between, its `completed` status is reverted to `stale`. |
| `video-project.service.ts` → `startStep()` | This is the in-flight lock. Two generate calls can both read `not_started` and both start. Today that's a duplicate Gemini call. **After Phase 08 it's a double charge, or a free double generation.** |
| `packaging.repository.ts` → `upsertGeneratedItem()` | ~~Calls `findByVideoProject()` **outside** the transaction, then writes inside it.~~ **Superseded by Phase 05a:** `findByVideoProject` is deleted and this is now a point read on `doc(videoProjectId)` *inside* the transaction. Do not go looking for the method. |

**Fixes:**

- `markStale` / `clearStale`: write **dotted field paths** (`itemStatuses.title`) instead
  of replacing the whole map. `upsertGeneratedItem` already does this correctly — these
  two just didn't follow the pattern.
- `startStep`: wrap in a real `runTransaction`. A lock that isn't atomic isn't a lock.
- `upsertGeneratedItem`: move the pre-read **inside** `runTransaction`.

> **`startStep` is deliberately NOT fixed here — it is deferred to
> [Phase 01b](./phase-01b-generation-seam.md).**
>
> 01b replaces `startStep` outright with `acquireStep`, which does the ownership check, the
> precondition and the lock inside one `runTransaction` and returns the pre-write project.
> Wrapping `startStep` in a transaction now means writing a lock that 01b immediately
> deletes, and the two would disagree about who owns the precondition in the meantime.
>
> The exposure while it is unfixed is unchanged from today: two concurrent generate calls on
> one project can both read `not_started` and both proceed, costing a duplicate Gemini call.
> That is the *existing* behaviour, not a regression — but it stops being merely wasteful at
> Phase 08, where it becomes a double charge. **Phase 01b is therefore a hard prerequisite
> for Phase 08, not just a tidy-up.** If 01b is ever deferred past 08, come back and do this.
>
> The other two races in this table are fixed here, because nothing later touches them.

---

## 4. Idea archiving can miss records

**Where:** `src/repository/content.repository.ts` → `archiveUserIdeas()`.

**In simple English:** it queries for the user's active ideas, then archives them in
chunks. An idea created between the query and the write escapes archiving and stays
active, so it shows up mixed into the next batch.

**Fix:** re-query per chunk, or archive by `batchId` rather than by "everything active".
Low severity on its own — worth doing here because Phase 04 walks the same collection
and the same race applies to the backfill.

---

## 5. Test-suite stability — watch, don't fix

**Status, measured 2026-08-24:** 330 tests, 20 suites, **all passing, six consecutive
clean runs.** Combined with seven clean runs observed in an earlier session, that is
thirteen in a row.

An earlier draft of this document claimed the suite "fails about one run in three". **That
is not reproducible and the claim has been withdrawn.** Do not go looking for a flake that
current evidence says is not there — that is wasted work, and worse, "fixing" a test that
isn't failing tends to weaken its assertions.

**What to do instead:** nothing, unless it recurs. If a suite does fail intermittently
during this migration, stop and treat it as a blocker, for the reason the original item
gave: **a genuine data-isolation bug and a flake look identical**, and the habit of
re-running until green hides the real one. In that case identify the suite (integration
tests under parallel load are the usual suspects), fix the shared state, or run with
`--runInBand`.

The goal is unchanged — **red means red**. Right now it already does.

### Observed while implementing this phase (2026-08-24)

Suite grew from 330 tests / 20 suites to **368 tests / 23 suites**, all passing.

**One unexplained non-match in 41 runs, not reproduced since.** During the first
ten-run stability loop, run 3 did not match the expected summary line. That loop
checked only the summary text and **did not capture the output**, so there is no
evidence of what happened — that was a mistake in how the check was written, not a
finding about the code.

Everything after it was clean: 12 more runs, then 20 further runs checking **both**
the exit code and the summary, capturing output on any mismatch. **32 consecutive
clean runs**, zero captured failures.

The two real-clock dependencies in the suite were inspected as candidates and
neither can produce a spurious failure: `hooks.service.iteration.test.ts:268` and
`content.service.script-iteration.test.ts:322` both build `startedAt` as
`toMillis: () => Date.now()`, so elapsed time is ~0 and always inside
`STEP_LOCK_MS`; `content.service.script-iteration.test.ts:110` yields one macrotask
before a **negative** assertion, which can only fail if something actually fired.

So: most likely a transient in the environment (ten back-to-back Jest runs spawning
workers), but that is an inference, not a diagnosis. **It is recorded rather than
dismissed.**

### Occurrence 2 (same day, also uncaptured)

`tests/integration/video-project.route.test.ts` reported one failing test in a full-suite
run. Run in isolation immediately after: **31/31 pass**. Three consecutive full-suite runs
after that: green. Then 15 more full-suite runs with output captured on non-zero exit:
**0 failures**.

The stack line in the failure output pointed at `src/app.ts:18` — which is a
`console.warn` about `ALLOWED_ORIGINS`, not a throw. Jest attributes console output that
way, so that line identified where a log came from, not where anything broke. The actual
assertion was never captured, again, because the output was filtered by grep instead of
saved.

**Two uncaptured failures in ~60 runs, both non-reproducible, no diagnosis for either.**

What is now different: the stability check saves full output on any non-zero exit rather
than grepping for a summary line, so a third occurrence is diagnosable rather than another
anecdote. Both failures happened during rapid successive full-suite runs on a loaded
machine, which is consistent with worker/resource contention and consistent with nothing
else being wrong — but that remains an inference.

### Occurrence 3 — captured, partially diagnosed, NOT resolved

The third occurrence was reproduced with output saved, which finally made it investigable.
Recording the whole investigation because the negative results are as useful as the positive
one.

**Established facts:**

- **Integration-only.** `tests/integration/hooks.route.behaviour.test.ts` alone: 0 failures
  in 20 runs. The integration group together: ~1 in 12. A different test fails each time.
- **Not parallelism.** `--runInBand` reproduces it. So it is not worker interference.
- **Not the rate limiter.** The suite makes ~113 supertest requests from one IP against
  `max: 100` (`middleware/rate_limit.ts`), which looked conclusive. Disabling it under test
  changed nothing — 3/20 after the change. The skip was kept anyway (the arithmetic is real
  and will bite as the suite grows) but it fixed nothing, and the comment there says so.
- **The `mockResolvedValueOnce` queue leaks, confirmed by direct probe.** `clearMocks: true`
  calls `mockClear()`, which resets call history but leaves queued once-values intact. A
  two-test probe proved it: test A queued a value and never called the mock; test B received
  it. The integration suites queue ~90 such values, and any request that short-circuits
  before reaching its service (a 400 from validation, a 404 thrown upstream) strands one.
- **Draining the queue helps but does not fix it.** A `mockReset()` of the service mock in
  each integration suite's `beforeEach` took it from 3/20 to **2/25**. Residual failures
  now show unexpected **403**s — `error_handler.ts`'s `Forbidden` string sentinel — on tests
  that mock nothing and expect a 400, and in one run two *different files* failed together.
- **`resetMocks: true` globally is not an option.** It drains the queue but also wipes
  module-scope `mockImplementation`s that many unit suites rely on: 126 failures.

**What this is not:** every failure so far is a test-infrastructure artefact — a stale mock
value or an unexpected status from a mock, never a production code path. No fix in this
phase changed behaviour to make it appear.

### RESOLVED — supertest was starting a server per request

The tell was the failure *shape*, not any one failure: `Number of calls: 0` on a service
mock, `res.body.success` undefined, and finally a bare **501 with an empty body**. A 501 does
not come from this app — it is Node's HTTP layer rejecting a request before Express sees it.
The request never arrived, which is exactly why no mock was called.

**Cause:** every suite used `request(app)` — passing the Express *app* rather than a
listening server. supertest then calls `app.listen(0)` for **every request** and tears the
server down after. Across the integration suite that is ~113 ephemeral servers bound and
closed within a few seconds, and occasionally one connection lost that race.

**Fix:** `tests/integration/shared-server.ts` — one server per file via `beforeAll`/`afterAll`,
with `request(server())` at the call sites. It is also simply the correct way to use
supertest for a suite of requests.

**Result: 0 failures in 30 integration runs and 20 full-suite runs** — 50 clean runs against
something that reproduced at roughly 1 in 12.

**Ruled out along the way, each with measurements** (recorded because the negative results
are what made the real cause findable):

| Hypothesis | Test | Verdict |
|---|---|---|
| Per-IP rate limiter (113 requests vs `max: 100`) | Disabled under test | No change — **not it**, though the skip was kept, since the arithmetic is real |
| Parallel worker interference | `--runInBand` | Still reproduced |
| ts-jest cache read mid-write | `--no-cache` | Still reproduced |
| Leaked `mockResolvedValueOnce` queue | Direct two-test probe | **Real, and a separate bug** — `clearMocks` (mockClear) does not drain the once-queue. Draining it in each suite's `beforeEach` improved the rate but did not remove it. Kept. |
| `resetMocks: true` globally | Tried | Drains the queue but wipes module-scope implementations — 126 failures. Rejected. |

**The rule from this item still stands:** a data-isolation bug and a flake look identical,
and the habit of re-running until green is what hides the real one. Every failure here turned
out to be test infrastructure — but that was established by diagnosis, not assumed. It is no
longer a blocker on using the suite as the Phase 06 gate.

---

## 6. Documents can be attached to a project without any ownership check

**This is the most exploitable thing in the whole plan, and it needs no tenancy work to
fix.** It was originally scheduled inside Phase 06; it belongs here, because it is a
`createdBy` one-liner that works on today's single-tenant model and is live right now.

`linkResource` (`video-project.service.ts:389-432`) validates the **project** — via
`this.getById(projectId, userId)` — and then writes `scriptId`, `hooksId` or `packagingId`
straight from the request body with **no check on the resource itself**:

| Linked type | What leaks |
|---|---|
| `packaging` | the `packaging` branch reads the foreign doc and copies its selected thumbnail brief onto your project as `thumbnailHint`, readable via `GET /v1/video-projects/:projectId` |
| `script` | `generate-shorts` returns the foreign script's content near-verbatim |
| `hooks` | `ContextService.resolveSelectedHook` (`context.service.ts:158-167`) fetches the batch by bare id with no check and feeds the selected hook into hook, title, description, thumbnail and shorts generation |

Today this needs a leaked UUID. After Phase 09 it is routine: someone removed from a
channel still knows every `scriptId` and `packagingId` in it and can replay them from their
own account.

**Fix:** validate the resource, not just the project — all three types, not just
`packaging`. `if (resource.createdBy !== userId) throw Forbidden()`. In Phase 06 that one
comparison becomes `accountId`, along with the other 17.

**The same shape, elsewhere.** These are not exploitable today because every caller passes
an already-checked id, but they take a bare document id with no ownership filter:

- ~~`findByVideoProject`~~ (**deleted in Phase 05a — this method no longer exists**) — queried by `videoProjectId`
  with no ownership filter at all. (Phase 05a deletes this method entirely.)
- `ContextService` resolves the idea, script and hooks by id with no checks, trusting that a
  project's stored pointers are internally consistent — which item 6 above is what makes true.
- `markStale`, `markPackagingDocumentStale`, `abandonStep` — bare `projectId`, no check.

State the rule in the repository layer and hold to it from here:

> A repository method that takes a bare document id returns `null` unless the document
> belongs to the caller.

Phrase it that way rather than "every method takes an `accountId` and filters" — Firestore
cannot filter a point read (`content.repository.ts:17`, `hooks.repository.ts:27`,
`packaging.repository.ts:31`, `video-project.repository.ts:40` are all `doc(id).get()`), and
an implementer following the stricter wording literally would convert point reads into
queries for no benefit. Phase 01b's `acquireStep` is the one deliberate exception: it must
read the project before it can know the account, and it does that read inside its own
transaction with the ownership check in it.

---

## 7. `POST /v1/packaging/save` writes an unvalidated request body

Same family as item 6 — fields the client should not control reaching the document — but
this one arrives through the body rather than a link id.

`packaging.controller.ts:68-69` destructures `videoProjectId` and passes `...rest` straight
through. `savePackaging` (`packaging.service.ts:348`) sets `normalized = { ...data }`,
deletes `script` and `hooks`, normalises the four `ITEM_FIELDS` — and passes **every other
key** to the write.

**What that defeats.** On the update branch (`packaging.service.ts:404-407`) the surviving
keys include `isStale`, `staleReason`, `staleSince` and `itemStatuses`. All four are
protected by deliberate design, with comments in that exact function explaining why:

> *"On update (re-save) we must NOT touch them: a plain re-save would otherwise silently
> un-stale a package that an upstream regenerate had marked stale."*

> *"`itemStatuses` is written on CREATE only. … recomputing it on update would rewrite a
> `stale` item back to `completed`."*

The code takes care not to *compute* those on update, then spreads the client's body over
them. `{"isStale": false}` in a save body clears a stale cascade that a script or hooks
regeneration set; `itemStatuses` rewrites per-item state wholesale. The user is then told
their packaging is current when it isn't — which is the one thing the cascade exists to
prevent.

**What saves it today, and shouldn't be relied on.** `createdBy` is *not* spoofable, because
`packaging.service.ts:383-387` writes the trusted fields **after** the spread:

```ts
const packagingData = { ...normalized, createdBy: userId, videoProjectId: projectId };
```

That is field ordering inside one object literal doing security work, undocumented. It holds
for `createdBy` and `videoProjectId` today. It is not a rule anyone will know to preserve.

**Fix:** a `packagingSaveSchema` in `src/validation/`, wired with `validate()` on the save
route. Allowlist the four item fields plus the thumbnail selection; Zod strips the rest,
which closes the stale-flag hole, the `itemStatuses` hole and the `accountId` risk Phase 03
would otherwise inherit, in one change.

**Phase 03 depends on this.** `accountId` must be stamped server-side after any body spread,
exactly as `createdBy` is. With the schema in place it cannot arrive from a client at all,
which is the stronger guarantee — do not rely on the ordering a second time.

**Noted, not fixed here:** **Superseded.** `validate()` is now used 21 times across 7 of the 8 routers (account 2, hooks 3, ideas 2, packaging 7, scripts 1, user 3, video-project 3); only `research.route.ts` has none, and it takes no bodies. `tests/unit/validation-coverage.test.ts` enforces it. Original text: `validate()` is used three times in `user.route.ts` and once in
`ideas.route.ts`, and **zero times** in the other five routers (`hooks`, `packaging`,
`research`, `scripts`, `video-project`). Packaging is where the gap has teeth, because its
body is spread onto a document. The rest is real but separate work.

---

## 8. The website scrape is unbounded

`extract.service.ts:11-15` is three lines:

```ts
getWebsiteContent = async (url: string): Promise<string> => {
  const res = await fetch(url);
  const html = await res.text();
  return extractTextFromHTML(html);
};
```

`extractTextFromHTML` (`utlils/regex.ts:2-12`) strips tags and collapses whitespace, then
returns — no truncation. `utlils/content.ts:170` stores the result verbatim. Zod caps the
fields a user *types* (`user.validation.ts:12` — `description` 5000, `purpose` 1000,
`website` 2000) but strips unknown keys, so every derived field bypasses validation
entirely: `websiteContent`, `channelDescription`, `userTitle[]` and `competitors[].titles`
are all unbounded at storage time. The only near-miss is `prompt-blocks.ts:56`, which caps
titles in the *prompt* and not in the document.

**Cap `websiteContent` at 20 KB** on the way in. The prompt effectively truncates it
regardless, so nothing downstream notices. Phase 02 relies on this as the second lock
behind the context subcollection.

While in this function, three guards are missing on what is a server-side fetch of a
**user-supplied URL**:

- **No timeout.** `research.repository.ts:13-15` uses `AbortSignal.timeout(8000)`;
  this path and `extract.repository.ts` have nothing, so onboarding and
  `POST /user/refresh-context` can hang on a stalled connection.
- **No response-size guard.** Nothing checks `Content-Length` or bounds the body before
  `res.text()` buffers the whole thing into memory.
- **No redirect or SSRF guard.** The URL comes from onboarding input, so a link to
  `169.254.169.254` or an internal host is fetched by the server and its response stored
  on the user's record.

The timeout and the size guard are a few lines each. The SSRF guard is the one worth
thinking about rather than pattern-matching — at minimum reject non-`http(s)` schemes and
private/link-local address ranges after DNS resolution, and don't follow redirects to them.

---

## How we'll know it worked

- `npm test` stays green across ten consecutive runs (it currently does — this is a
  regression check, not a repair).
- A test proving a missing user record no longer throws on a counter write.
- A test proving `markStale` doesn't revert a concurrently-completed item.
- Both `createdBy` counts recorded in the Phase 04 document: empty-string **and** absent.
- A test proving `linkResource` refuses a `scriptId`, `hooksId` and `packagingId` belonging
  to another user — three assertions, one per resource type.
- A test proving a `save` body carrying `isStale: false` and a forged `itemStatuses` leaves
  both untouched on an already-stale package.
- A test proving a 1 MB scrape is stored truncated to 20 KB, and one proving a URL that
  never responds fails on the timeout instead of hanging the request.

---

## Rollback

Every item is an independent commit and independently revertable. Nothing here changes
data shape, only correctness.

---

## Risks

**Low, with two exceptions.**

Changing `createdBy: userId || ""` to a throw could surface a path where `userId` is
genuinely absent that nobody knew about. That's the point — but deploy it where you can
watch the logs, rather than late on a Friday.

Item 6 makes `linkResource` refuse things it used to accept. If any legitimate client flow
links a resource it doesn't own, this breaks it — and that would itself be a finding worth
having. Log every refusal as a structured event for the first release so a false positive is
visible rather than reported as "linking is broken".

Item 2 is the one with a deployment gotcha rather than a behavioural one: `functions/` is a
**separate deploy artifact** and does not ride the API's `dist/`. See the deploy table in
the README — a fix merged but not deployed with `firebase deploy --only functions` has not
shipped.
