---
title: "Phase 01b — The Generation Seam"
description: "One place where locking, preconditions, credits and telemetry attach to a model call."
date: 2026-08-24
last_updated: 2026-08-26
status: "partial — 2 of 11 model calls routed"
tags: ["multi-account", "phase-01b", "architecture", "generation"]
---

# Phase 01b — The Generation Seam

**Size:** medium. One new constants file, two new repository methods, one new service, and
a conversion per generation service.
**Depends on:** Phase 01 (items 3 and 6).
**Blocks:** Phase 08. Runs alongside Phases 02–06 without touching them.

---

## Why this phase exists

There are twelve places in this codebase that call a Gemini model:

```
content.service.ts:118   generateIdeas
content.service.ts:237   generateScripts       (SSE — streams to res)
content.service.ts:401   regenerateAll         (ideas)
content.service.ts:425   regenerateOne         (ideas)
content.service.ts:478   regenerateScript
hooks.service.ts:58      generate
hooks.service.ts:169     regenerate
packaging.service.ts:174 generateTitle
packaging.service.ts:181 generateDescription
packaging.service.ts:193 generateThumbnail
packaging.service.ts:205 generateShorts
packaging.service.ts:503 regenerateItem        (handles all four items)
```

Every concern that surrounds a model call — the in-flight lock, the pipeline transition,
rollback on failure, telemetry — is hand-attached at each of these, and they disagree with
each other. `hooks.generate` and `hooks.regenerate` run the same core operation and share
almost none of their surroundings. Packaging generates *before* it locks. All five
`startStep` calls swallow their own failure.

None of that is a bug today. It becomes one the moment something has to be **true of every
generation** — which is exactly what Phase 08 (credits) and Phase 09 (roles) require.

**The measurement that justifies this phase:** adding credits without a seam means writing
the debit and the refund twelve times, with twelve chances to leak a refund. Adding it with
a seam is two lines.

---

## The three real problems, stated plainly

### 1. The lock is not a lock

`content.service.ts:262-266` and `hooks.service.ts:82-86` each read `project.pipeline.<step>`,
compare `startedAt` against `STEP_LOCK_MS` (`video-project.service.ts:28`, 180 s), and then
*separately* call `startStep` to write `in_progress`. Read and write are not atomic, so two
requests can both read `not_started` and both proceed.

The code already knows. Both sites carry the same comment:

> `// ponytail: ~ms read-then-start race remains; move to a transaction if concurrent tabs become a real pattern.`

This phase is that upgrade path. There is exactly one `runTransaction` in the whole
codebase (`packaging.repository.ts:102`) and `video-project.service.ts` has none.

### 2. Every `startStep` failure is swallowed

All five call sites — `content.service.ts:288`, `hooks.service.ts:94`,
`packaging.service.ts:248`, `:441`, `:638` — are shaped like this:

```ts
try {
  await this.videoProjectService.startStep(videoProjectId, "hooks", userId);
} catch (stepError) {
  console.error(JSON.stringify({ event: "pipeline_start_failed", ... }));
}
```

Generation proceeds regardless. That is deliberate and correct *for a pipeline transition*
— a bookkeeping hiccup should not fail a generation the user is waiting for. It is fatal
for anything that must gate, which is what Phase 08 would have been bolting on.

**What that swallowing already cost: `reconcileView`.** Stored step state drifts whenever one
of those five `catch` blocks fires, so `video-project.service.ts:149-177` recomputes
`script` and `hooks` completion at read time from `scriptId` / `selectedHookIndex`. It is a
read-time patch over this write-time bug, and it is applied inconsistently:
`getById` returns the reconciled status, `list` (`:118-125`) returns the **stored** one.

That inconsistency has a sharp edge. `list` accepts `?status=` and that filter runs *in the
Firestore query, against the stored field*. A project stored `in_progress` that reconciles to
`completed` shows up under `?status=in_progress`, opens as completed, and is missing from
`?status=completed` altogether. Reconciling inside `list` cannot fix it — the filter and the
page boundary are applied server-side before any of our code sees the rows, so it would
return short pages and a wrong `hasMore`. Read-time reconciliation and query-time filtering
are structurally incompatible.

This phase removes the cause: the runner owns rollback, and a failed transition is no longer
a silent `console.error`. It does not retroactively repair documents that already drifted, so
do **not** simply delete `reconcileView` here. The cheap resolution is to make it
self-healing — when the reconciled status differs from the stored one, persist the
correction. It fires rarely by construction, makes both views agree, fixes the `?status=`
filter, and repairs legacy documents the first time they are opened. Same shape as
`ensureDefaultAccount` in Phase 03.

**Two more invariant leaks in the same machinery**, found while writing behaviour tests
for the pipeline (2026-08-24). Both are in `video-project.service.ts`, both are the same
shape — a step mutation that doesn't maintain the invariants every other one upholds —
and both belong here, because this phase is what redefines step transitions:

- **`completeStep` can move `currentStep` BACKWARD.** `startStep` guards advancement
  (`:298`, `if (newStepIndex > currentStepIndex)`), but `completeStep` writes
  `updates["currentStep"] = nextStep` unconditionally, derived from the step just
  completed and never compared against the project's actual `currentStep`. So completing
  an *earlier, reopened* step drags the pipeline back: re-select a hook on a project that
  already reached packaging and `currentStep` becomes `"title"`. Reachable through both
  reopen paths (`reopenTitleStep`, `clearSelectedHook`) and through the ordinary hooks
  re-select flow. Contradicts "currentStep only advances forward".

- **`reopenTitleStep` and `clearSelectedHook` never recompute `overallStatus`** (`:451-471`).
  Every other pipeline mutation does. A project sitting at `completed` stays `completed`
  on the dashboard while a step reopens underneath it.

All three defects (these two plus the `reconcileView` divergence above) are pinned by
`it.failing` tests in `tests/unit/service/video-project.pipeline.behaviour.test.ts`. Those
pass only while the bug exists and fail the moment it is fixed — so whoever does this work
gets told to promote them to normal assertions rather than discovering them by accident.

### 3. Flow logic lives inside an action

`hooks.service.ts:65` refuses to generate unless `project.pipeline.script.status ===
"completed"`. That is pipeline sequencing embedded in a generation action: change the flow
and you edit the action.

**This is the only pipeline-status precondition in the codebase.** There are four reads of
`.pipeline.` outside `video-project.service.ts`:

| Site | What it is |
|---|---|
| `video-project.repository.ts:27` | back-compat hydrate for legacy projects |
| `hooks.service.ts:65` | **the precondition** |
| `hooks.service.ts:82` | the hooks lock |
| `content.service.ts:262` | the script lock |

Packaging's checks (`packaging.service.ts:102-104`, `:159-161`, `:531-536`,
`packaging.controller.ts:32-34`, `:45-47`) look similar but are **input-shape** checks — "is
there a script string" — not flow checks. They must stay exactly as they are: they are what
lets the packaging *doors* work on a project whose script step never ran.

So the whole of "flow-bound" is one `if`, plus a lock duplicated twice. That is the budget
this design is allowed to spend.

---

## The design

### The pipeline, declared once

```ts
// src/constants/pipeline.ts  (new)

export const STEP_ORDER = ["research", "script", "hooks", "title", "packaging"] as const;
export type StepName = (typeof STEP_ORDER)[number];

/** A step may not start until these are `completed`. Empty = no precondition. */
export const REQUIRES: Record<StepName, readonly StepName[]> = {
  research: [],
  script: [],
  hooks: ["script"],   // was hooks.service.ts:65
  title: [],           // deliberately NOT ["script"] — the Title door accepts a body script
  packaging: [],       // same: description/thumbnail/shorts are doors
};

/** Everything a metered model call can be. Not all kinds are pipeline steps. */
export type GenerationKind =
  | "ideas" | "script" | "hooks" | "title"
  | "description" | "thumbnail" | "shorts" | "prefill";

/**
 * Which kinds own a pipeline step. Owning a step means: locked while running,
 * preconditions enforced, rolled back on failure.
 *
 * Kinds ABSENT here are metered and traced but never locked. That is not a
 * compromise — packaging fans description + thumbnail + shorts out concurrently
 * from one screen, and packaging.repository.ts:102-141 already runs the
 * create-or-update, the itemStatuses read-modify-write and the "all done?"
 * check in ONE transaction, which is strictly stronger than a step lock.
 * Locking them would refuse two of the three.
 */
export const KIND_STEP: Partial<Record<GenerationKind, StepName>> = {
  script: "script",
  hooks: "hooks",
  title: "title",
};

/** An in_progress step older than this outlived the Gemini timeout = crashed run. */
export const STEP_LOCK_MS = 180_000;
```

`STEP_LOCK_MS` moves here from `video-project.service.ts:28`. `StepName` moves here from
`types/routes/video-project.ts:5`, which re-exports it so no import anywhere else changes.

**`STALE_CASCADE` is deleted, not moved.** The hand-written map at
`video-project.service.ts:17-22` is exactly "every step after this one in `STEP_ORDER`" —
verified entry by entry. It becomes:

```ts
const downstreamOf = (step: StepName): readonly StepName[] =>
  STEP_ORDER.slice(STEP_ORDER.indexOf(step) + 1);
```

Six lines that can drift silently become one that cannot.

### A real lock, in the repository

Firestore transactions only exist in repositories, and the ownership check and the
precondition must be *inside* the transaction to be atomic. So the repository enforces a
guard it is handed; the policy stays in `constants/pipeline.ts`.

```ts
// src/repository/video-project.repository.ts  (new methods)

export interface StepGuard {
  requires: readonly StepName[];
  lockMs: number;
}

/**
 * Take the in-flight lock atomically. Replaces the read-then-write pairs at
 * content.service.ts:262-266 + :288 and hooks.service.ts:82-86 + :94, neither of
 * which was a lock. Returns the PRE-write project so callers can read
 * scriptId/hooksId for idempotent replay and the runner can restore prior state.
 */
acquireStep = async (
  projectId: string,
  step: StepName,
  userId: string,
  guard: StepGuard
): Promise<IVideoProject> =>
  this.db.runTransaction(async (txn) => {
    const ref = this.db.collection(this.collection).doc(projectId);
    const snap = await txn.get(ref);
    if (!snap.exists) throw NotFound();

    const project = this.hydrate(snap.data() as IVideoProject);
    if (project.isDeleted) throw NotFound();
    if (project.createdBy !== userId) throw Forbidden();   // → accountId in Phase 06

    for (const required of guard.requires) {
      if (project.pipeline[required].status !== "completed") {
        throw BadRequest(`${required} must be completed before generating ${step}`);
      }
    }

    const state = project.pipeline[step];
    const startedMs = state.startedAt?.toMillis() ?? 0;
    if (state.status === "in_progress" && Date.now() - startedMs < guard.lockMs) {
      throw Conflict(`${step} generation already in progress for this project`);
    }

    if (state.status !== "completed") {
      const updates: Record<string, unknown> = {
        [`pipeline.${step}.status`]: "in_progress",
        [`pipeline.${step}.startedAt`]: FieldValue.serverTimestamp(),
      };
      if (STEP_ORDER.indexOf(step) > STEP_ORDER.indexOf(project.currentStep)) {
        updates["currentStep"] = step;
      }
      txn.update(ref, updates);
    }

    return project;
  });

/** Restore a step to exactly what it was before acquireStep. */
releaseStep = async (
  projectId: string,
  step: StepName,
  prior: { status: StepStatus; startedAt: Timestamp | null }
): Promise<void> => { /* dotted-path update of status + startedAt */ };
```

**`releaseStep` fixes a live bug.** `VideoProjectService.abandonStep`
(`video-project.service.ts:304-309`) hardcodes `not_started`. When the step being abandoned
was **stale**, that silently clears its stale marker — so a failed regenerate of a stale
step makes the step look fresh. Restoring captured prior state fixes it for free.

**Named trade-off:** a repository now throws `HttpError`. The alternative is a result type
the runner relays — more code for the same three failures, in service of a purity that
`utlils/errors.ts` (a shared util, not a layer) does not demand.

### The runner

```ts
// src/service/step-runner.ts  (new)

/** Who is generating. Phase 05 adds accountId here — one place, not twelve. */
export interface Actor { userId: string; accountId?: string }

export interface GenerationSpec {
  actor: Actor;
  kind: GenerationKind;
  /** Project-scoped runs are locked and precondition-checked. Ideas/prefill pass none. */
  projectId?: string;
}

/**
 * The one place cross-cutting concerns attach to a model call.
 *
 * OWNS:   the in-flight lock (transactional), preconditions, rollback on
 *         failure, structured telemetry, and — from Phase 08 — credits.
 * DOES NOT OWN: prompts, generation configs, persistence, step COMPLETION,
 *         the stale cascade, or SSE framing. Those differ per action by design;
 *         forcing them in here produces flags, not modularity.
 */
run = async <T>(spec: GenerationSpec, generate: () => Promise<T>): Promise<T> => {
  const step = KIND_STEP[spec.kind];
  let prior = null;

  if (step && spec.projectId) {
    const project = await this.projects.acquireStep(
      spec.projectId, step, spec.actor.userId,
      { requires: REQUIRES[step], lockMs: STEP_LOCK_MS }
    );
    prior = { ...project.pipeline[step] };
  }

  // Phase 08 inserts exactly one line here:
  //   await this.billing.debit(spec.actor, CREDIT_COSTS[spec.kind]);

  try {
    const out = await generate();
    console.log(JSON.stringify({ event: "generation_ok", kind: spec.kind, ... }));
    return out;
  } catch (error) {
    //   await this.billing.refund(spec.actor, CREDIT_COSTS[spec.kind]);
    if (step && spec.projectId && prior) {
      await this.projects.releaseStep(spec.projectId, step, prior).catch(logReleaseFailure);
    }
    console.error(JSON.stringify({ event: "generation_failed", kind: spec.kind, ... }));
    throw error;
  }
};
```

**`acquireStep` failure is NOT swallowed.** That is the entire point — five swallowed
`startStep` calls are why credits would have been unenforceable. The failures it raises
(404 / 403 / 400 / 409) are ones the controllers already surface correctly, including the
SSE controller (`script.controller.ts:24-29`).

**Named trade-off:** the runner does not solve tenancy. Repositories still need `accountId`
on their queries — that is Phase 06's job, and it reaches ~45 handlers, not 12. This seam
makes credit and lock threading O(1); it does not pretend to make query threading O(1).

---

## What a converted call site looks like

`hooks.generate`, the most representative:

```ts
generate = async (userId, videoProjectId, script?) => {
  // Idempotent replay stays OUTSIDE the seam: returning an existing batch is not
  // a generation. It must not take the lock and must not spend a credit.
  const project = await this.videoProjectService.getById(videoProjectId, userId);
  if (project.hooksId) {
    const existing = await this.repo.findById(project.hooksId);
    if (existing) return existing;
  }

  const resolvedScript = await this.resolveScript(userId, videoProjectId, script);
  const userPrompt = fillTemplate(GENERATE_HOOKS_PROMPT, { "{script}": resolvedScript });

  const hooksBatch = await this.steps.run(
    { actor: { userId }, kind: "hooks", projectId: videoProjectId },
    async () => {
      const result = await generateStreamingContent(
        HOOKS_SYSTEM_PROMPT, userPrompt, GENERATION_CONFIG_HOOKS
      );
      const parsed = await collectJson<{ hooks: string[] }>(result, "hooks");
      assertHooks(parsed);
      return this.repo.save({ videoProjectId, createdBy: userId, hooks: parsed.hooks, hookFeedback: {} });
    }
  );

  // linkResource stays here — it is persistence wiring, not generation.
  ...
};
```

Removed from this method: the precondition (`:64-67`), the hand-rolled lock (`:82-86`), the
swallowed `startStep` (`:93-97`), and the abandon-on-failure block (`:109-119`). Roughly 24
lines out, 6 in.

`hooks.regenerate` gets the wrap too — but with `mode: "regenerate"`, which means telemetry
and metering **without** the lock or the preconditions.

> ### ⚠️ Correction: regeneration must NOT take the step lock
>
> An earlier version of this document said regenerate "gets the identical three-line wrap and
> thereby gains the lock and the metering it never had." That was implemented, reviewed, and
> **it broke the primary regenerate flow.** The correction matters more than the original
> advice, because the mistake is an easy one to make twice.
>
> **`pipeline.<step>.status === "in_progress"` does not mean "a generation is running."** It
> means *the user is working on this step*, and it stays that way for as long as they take.
> Hooks is the clearest case: `generate` sets it and only `select` clears it, so between
> generating hooks and picking one, the step is permanently `in_progress`.
>
> Treating that as an in-flight lock produces:
>
> - the ordinary "I don't like these, try again" click **409s for the full 180s window**;
> - and because a *successful* regenerate calls `clearSelectedHook` — which sets the step
>   back to `in_progress` — each regenerate **re-arms the false lock for the next one**.
>
> The preconditions fail for the same reason. `REQUIRES.hooks = ["script"]` is a rule about
> *starting* the hooks step. After an upstream regen marks `script` stale, regenerating hooks
> is exactly what the user needs, and the precondition would 400 it.
>
> So regeneration keeps the behaviour it had before the seam. That is **not** the end state:
> two concurrent regenerates are a real double-charge risk once credits land. But the fix is
> a genuine in-flight marker — a `generationStartedAt` distinct from step status — not
> overloading a field that already means something else. Until that exists, regeneration is
> unlocked, exactly as it always was.
>
> Pinned by two regression tests in `tests/unit/hooks.service.iteration.test.ts`
> ("regenerate is not blocked by step state"), both canary-verified to fail if the `mode`
> flag is removed.

### Two known gaps in the lock, for whoever finishes this phase

Neither is a regression — both are limits of the mechanism as built.

1. **`releaseStep` has no compare-and-swap.** It blindly writes the `prior` it captured. If
   run A's generation outlives `STEP_LOCK_MS`, run B legitimately takes over the stale lock,
   and A *then* fails, A's rollback overwrites B's live `in_progress` — letting a third
   request acquire while B is still generating. Close it by restoring only when `startedAt`
   still matches what this acquisition set, inside a transaction.

2. **The lock is a no-op on a `completed` step.** `acquireStep` skips its write entirely when
   `status === "completed"`, so two concurrent calls both pass the checks and neither takes
   anything. Generate is protected by its idempotent replay before the seam, so this is
   currently unreachable — but the guarantee in the method's own doc comment does not hold
   for that state.

**Named trade-off:** the replay path costs one extra project read (`getById`, then
`acquireStep` reads again inside its transaction). One read to stop a replay from spending a
credit is the right side of that trade.

### The lock shipped untested, and the tests hid it

Worth recording, because the failure mode is not obvious and will recur.

`acquireStep`/`releaseStep` had **zero** tests. The suites that looked like they covered
them — the service-level "409s while a generation is in flight" and "rejects generation when
the script step is not completed" — were asserting against `tests/helpers/step-runner.ts`, a
hand-written stand-in whose guard logic was written to match. Both would have passed with the
real transaction deleted. A helper that reimplements the thing under test converts a coverage
gap into a coverage *claim*, which is worse than the gap.

Closed by `tests/unit/repository/step-lock.behaviour.test.ts` (15 tests, canary-verified
against three mutations: dropped ownership check, unconditional `currentStep`, clobbered
`completed` step). The helper's doc comment now says which suite is the authority. Rule for
the rest of this phase: **refusals belong in the repository suite; the fake covers only what
happens around the seam.**

---

## The four shapes that don't fit a uniform mould

These are where a naive version of this design dies. Each is handled without a flag.

### SSE script — cannot send 402 after `flushHeaders()`

**The seam runs entirely before the stream opens.** New ordering in `generateScripts`:
replay check → resolve prompt inputs → `steps.run(...)` → *inside the closure*:
`openSseStream(res)`, stream, persist.

Everything that can produce an HTTP status (403 not-owner, 409 locked, 402 no credits)
happens while `res.headersSent === false`, and `script.controller.ts:24-29` already turns
that into a clean `res.sendError`. No controller change.

**The empty-output case stops being a special path.** `content.service.ts:324-328` currently
logs, calls `abandonStep`, and **returns normally** with an empty string — so a
refund-on-throw wrapper would never fire and a failed 5-credit script generation would charge
full price. Instead the closure throws `ServiceUnavailable` *after* the `finally` has already
written `[DONE]` and called `res.end()`. The runner sees the throw, releases the step and
refunds; the controller's `headersSent` branch swallows it. The client's experience is
unchanged — an empty `[DONE]` — and the manual `abandonStep` call is deleted.

**Named limit:** a failure *mid-stream* still cannot be reported as a status code. That is
SSE, not this design.

### Ideas — no project at all

`generateIdeas` precedes project creation, so `projectId` is optional: no project means no
`acquireStep`, no precondition, no lock. Credits and telemetry still apply.

That closes a real gap. Ideas are the most expensive generation in the system by external
quota (see Phase 08) and are currently metered by a **floating, unawaited**
`userRepo.update` at `content.service.ts:181-184`.

Wrap `generateIdeas` itself, not the three controllers: `regenerateAll` (`:401`) and
`regenerateOne` (`:425`) both funnel through it, so one wrap covers three entry points — and
it charges once per model call, which is the correct unit, since `regenerateOne` deliberately
generates a full batch and keeps one.

### Packaging fan-out — three concurrent generations

Handled by `KIND_STEP` having no entry for `description` / `thumbnail` / `shorts`. They are
unlocked by construction, which is safe for the reason given in the constants file above.

**The seam attaches at packaging's private helper, not at the four public methods** — one
wrap instead of five. `generateTitle` / `generateDescription` / `generateThumbnail` /
`generateShorts` need no change at all.

**The generate → persist → `startStep` ordering stays.** It is tempting to "fix" it for
consistency. Don't: packaging's step transition is a function of *persisted item state*
(`statuses.description && thumbnail && shorts`), not of "a generation started". Moving
`startStep` earlier would flip the step to `in_progress` on a generation that then fails.
`persistGeneratedItem` (`:219-263`) is untouched.

### `regenerateItem` — four items, deliberately bypassing the public wrappers

It gets the seam for free: it calls the private `run*` methods, which call the now-wrapped
private helper. Its `itemStatuses` rollback (`:565-571`) stays — that is packaging-document
state, which the runner explicitly does not own.

Its `startStep` / `completeStep` at `:638-639` **stays too.** It is not a lock; it repairs a
step left `in_progress` after a partial failure. (An earlier draft of this plan claimed no
regenerate path calls `startStep` — that was wrong, and deleting this call would reintroduce
the stuck-step bug it exists to fix.)

---

## What we deliberately do not build

1. **A step registry** (`interface Generator { prompt, config, persist, cost }`) — an
   interpreter for five hardcoded steps. It would also pull prompt and config selection into
   a file the AI-engineer role owns (see `.claude/rules/ai-generation-patterns.md`).
2. **A composable middleware chain** (`compose(withLock, withCredits, withTrace)`) — three
   concerns, always all three, always the same order. That is a function, not a framework.
3. **A state machine library or event-sourced pipeline.** `STEP_ORDER` + `REQUIRES` is a
   dozen lines and one loop.
4. **A rules DSL for preconditions.** One `Record`, one `for`.
5. **Uniform step *completion* inside the seam.** Completion genuinely differs: script
   completes on save, hooks and title on a user's *selection* (`hooks.service.ts:162`,
   `packaging.service.ts:494`), packaging on 3-of-3. Forcing it uniform produces
   `{ completeOnSuccess: false }` flags — the exact coupling this phase removes, wearing a hat.
6. **`AsyncLocalStorage` for ambient actor/tenancy.** It would make every repository call
   implicitly scoped, untestable without a context harness, and silently wrong when a callback
   escapes the context. The static test below gives the same guarantee with no production code.
7. **A job queue or outbox.** Serverless plus SSE. Nothing asks for it.
8. **Merging `generate` and `regenerate` behind a boolean.** Six `if (isRegen)` branches in
   one function is worse than two functions. Extract the ~10 genuinely shared lines; leave
   the rest.
9. **Type-branding `UserId` / `AccountId` to catch `where("accountId", "==", userId)`.**
   It cannot work: `@google-cloud/firestore` types `where()`'s value parameter as `any`
   (`node_modules/@google-cloud/firestore/types/firestore.d.ts:1738-1742`), so a branded
   value passes clean. It would only reach
   the in-memory comparisons, and only after branding five interface files plus ~79
   `userId: string` occurrences across `src/`. If the queries are the goal, one typed
   repository helper that all query sites route through is cheaper and actually correct.

---

## The test that keeps it true

Static, in the spirit of `tests/unit/auth-coverage.test.ts`, which already walks every route
file asserting auth is mounted. Use the TypeScript AST rather than a regex — `typescript` is
already a dependency via `ts-jest`, and brace-matching a callback with a regex is the kind of
clever that breaks at 3 a.m.

**The invariant:** every call to `generateContent` / `generateStreamingContent` anywhere under
`src/` is lexically inside a `steps.run(...)` callback. No allowlist, so a thirteenth action
is found by walking rather than by remembering.

Include the same vacuous-pass canary `auth-coverage.test.ts` uses — a scanner that finds
nothing passes for the wrong reason.

**Known ceiling:** it matches on the receiver name (`steps` / `stepRunner`). Renaming that
field silently disarms it. That is a one-line fix when it happens, and it costs less than a
full type-checked program.

---

## Migration order

Each step compiles, passes the suite, and reverts on its own.

1. **`src/constants/pipeline.ts`** — move `STEP_ORDER` / `StepName` / `STEP_LOCK_MS`, add
   `REQUIRES` / `GenerationKind` / `KIND_STEP`, derive the cascade, delete `STALE_CASCADE`.
   Re-export `StepName` from `types/routes/video-project.ts` so no import churn.
   `video-project.service.test.ts` proves the cascade is unchanged.
2. **`acquireStep` + `releaseStep`** on the repository, alongside the existing
   `startStep`/`abandonStep`. Nothing calls them yet — dead code for one commit, by design.
3. **`StepRunner` + wiring** in the four route files. Still nothing calls `run`.
4. **Convert one service per commit:** hooks (2 sites) → ideas (1) → script SSE (1) →
   packaging (1 helper) → prefill (1). After the hooks commit, delete `hooks.service.ts:64-67`.
   After the script commit, delete `VideoProjectService.abandonStep`.
5. **The guard test.** Lands last, because it fails until step 4 is done — which is the point.

---

## How we'll know it worked

- Two concurrent script generations on one project: one streams, the other gets 409. Today
  both proceed.
- A failed hooks generation leaves the step exactly as it was — including `stale` if it was
  stale before. Today it is set to `not_started`.
- A script generation that produces nothing does not complete the step and does not persist
  an empty script (unchanged behaviour, now via a throw rather than a special path).
- Packaging still fans out three concurrent generations with no 409.
- A packaging *door* call (no `videoProjectId`) still works with no project and no lock.
- A project whose stored status disagrees with its reconciled one is corrected on first read,
  and then appears under the correct `?status=` filter in `GET /v1/video-projects`. Today it
  is filed under the stale value and missing from the right one.
- The guard test fails when a model call is added outside the seam. Prove it by adding one
  temporarily.
- `npm test` green, ten runs (Phase 01 item 5 is a hard dependency here).

---

## Rollback

Steps 1–3 are additive and revert cleanly. Step 4 reverts per service — each conversion is
its own commit, so a single misbehaving service can go back without the others. The old
`startStep` / `abandonStep` remain in place until step 4 is complete, so there is no window
where neither mechanism exists.

---

## Risks

**The lock becomes real, and real locks refuse things.** Today two concurrent generations
both succeed and one silently wins. After this, one gets a 409. That is correct, and it is
also a behaviour change users can see — the frontend must render it as "already generating"
rather than as an error. Ship it where you can watch the logs.

**The SSE reordering is the delicate one.** Everything that can fail with a status code has to
happen before `flushHeaders()`. Get it wrong and a 403 becomes a dead stream. The acceptance
check for it is specifically "a non-owner gets a JSON 403, not an empty event stream".
