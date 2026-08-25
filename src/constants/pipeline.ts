// The pipeline, declared once.
//
// Before this file, the same facts were spelled out in three places that could
// drift independently: STEP_ORDER and a hand-written STALE_CASCADE map in
// video-project.service.ts, a precondition hard-coded inside hooks.service.ts,
// and a lock duration next to it. Two of the three are now derived rather than
// written down.

export const STEP_ORDER = ["research", "script", "hooks", "title", "packaging"] as const;
export type StepName = (typeof STEP_ORDER)[number];

/**
 * A step may not start until these are `completed`. Empty = no precondition.
 *
 * `title` and `packaging` are deliberately empty rather than `["script"]`. Both
 * are *doors*: `POST /packaging/generate-title` and the description/thumbnail/
 * shorts endpoints accept a script in the body and work on a project whose script
 * step never ran. Adding the obvious-looking precondition here would close those
 * doors — which is the kind of change that looks like tightening and is actually
 * a feature removal.
 */
export const REQUIRES: Record<StepName, readonly StepName[]> = {
  research: [],
  script: [],
  hooks: ["script"], // was hard-coded at hooks.service.ts:65
  title: [],
  packaging: [],
};

/** Everything a metered model call can be. Not all kinds are pipeline steps. */
export type GenerationKind =
  | "ideas"
  | "script"
  | "hooks"
  | "title"
  | "description"
  | "thumbnail"
  | "shorts"
  | "prefill";

/**
 * Which kinds own a pipeline step. Owning a step means: locked while running,
 * preconditions enforced, rolled back on failure.
 *
 * Kinds ABSENT here are traced (and, from Phase 08, metered) but never locked.
 * That is a decision, not an omission: the packaging screen fans description,
 * thumbnail and shorts out CONCURRENTLY, and `packaging.repository.ts`'s
 * `upsertGeneratedItem` already runs create-or-update, the `itemStatuses`
 * read-modify-write and the "all four done?" check inside ONE transaction —
 * strictly stronger than a step lock. Locking them would refuse two of the three.
 *
 * `ideas` and `prefill` are absent because they have no project at all.
 */
export const KIND_STEP: Partial<Record<GenerationKind, StepName>> = {
  script: "script",
  hooks: "hooks",
  title: "title",
};

/**
 * An `in_progress` step older than this outlived the Gemini timeout, so the run
 * that set it has certainly crashed and the lock is stale.
 */
export const STEP_LOCK_MS = 180_000;

/**
 * Every step after `step`, in order — what a regeneration invalidates.
 *
 * Replaces a hand-written STALE_CASCADE map. Checked entry by entry against the
 * old map before deleting it: research → [script, hooks, title, packaging],
 * script → [hooks, title, packaging], hooks → [title, packaging],
 * title → [packaging], packaging → []. The map was exactly this suffix, so it was
 * six lines that could drift silently against one that cannot.
 */
export const downstreamOf = (step: StepName): readonly StepName[] =>
  STEP_ORDER.slice(STEP_ORDER.indexOf(step) + 1);
