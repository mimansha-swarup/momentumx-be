import VideoProjectRepository from "../repository/video-project.repository.js";
import {
  GenerationKind,
  KIND_STEP,
  REQUIRES,
  STEP_LOCK_MS,
} from "../constants/pipeline.js";
import { StaleReason, StepState } from "../types/routes/video-project.js";
import { RecordOwner } from "../utlils/content.js";

/**
 * Who is generating — Phase 06 made `accountId` required, which is what this seam
 * was for.
 *
 * It is `RecordOwner` rather than a second interface of the same shape: two
 * structurally identical types are indistinguishable to the compiler, so nothing
 * would stop one drifting from the other, and the reason both exist — an OBJECT,
 * because `userId` and `accountId` are both `string` and a positional parameter
 * silently accepts the wrong one — is exactly the same reason.
 */
export type Actor = RecordOwner;

export interface GenerationSpec {
  actor: Actor;
  kind: GenerationKind;
  /**
   * Project-scoped runs are locked and precondition-checked. Ideas and prefill
   * pass none, because they have no project.
   */
  projectId?: string;
  /**
   * `"create"` (default) takes the step lock and enforces preconditions.
   * `"regenerate"` does neither — it still gets telemetry and, from Phase 08,
   * metering.
   *
   * WHY THIS DISTINCTION EXISTS. `pipeline.<step>.status === "in_progress"` does
   * NOT mean "a generation is running". It means "the user is working on this
   * step", and it stays that way for as long as they take. Hooks is the clearest
   * case: `generate` sets it, and only `select` clears it — so between generating
   * hooks and picking one, the step is permanently `in_progress`.
   *
   * Treating that as an in-flight lock breaks regeneration outright: the ordinary
   * "I don't like these, try again" click 409s for the full lock window. Worse,
   * a *successful* regenerate calls `clearSelectedHook`, which sets the step back
   * to `in_progress` — so each regenerate re-arms the false lock for the next one.
   *
   * The preconditions are wrong here for the same reason. `REQUIRES.hooks =
   * ["script"]` is a rule about *starting* the hooks step. Regenerating an
   * existing batch after an upstream regen marked `script` stale is exactly when
   * the user needs it most, and it would 400.
   *
   * So regeneration keeps the behaviour it had before the seam: no lock, no
   * precondition. It does NOT keep it forever — concurrent regenerates are a
   * genuine double-charge risk once credits land. But the fix is a real in-flight
   * marker distinct from step status, not overloading a field that already means
   * something else. Tracked in Phase 01b.
   */
  mode?: "create" | "regenerate";
}

/**
 * The one place cross-cutting concerns attach to a model call.
 *
 * OWNS: the in-flight lock (transactional), preconditions, rollback on failure,
 * structured telemetry, and — from Phase 08 — credits.
 *
 * DOES NOT OWN: prompts, generation configs, persistence, step COMPLETION, the
 * stale cascade, or SSE framing. Those genuinely differ per action; forcing them
 * in here produces a function with eight flags, which is not modularity.
 *
 * Why this exists: twelve model-call sites each hand-attached their own
 * surroundings and disagreed. Five `startStep` calls swallowed their own failure
 * in a `catch { console.error }`, which is fine for bookkeeping and fatal for
 * anything that must gate. Adding credits without a seam means writing the debit
 * and the refund twelve times, with twelve chances to leak a refund. With one,
 * it is two lines.
 */
class StepRunner {
  constructor(private projects: VideoProjectRepository) {}

  run = async <T>(spec: GenerationSpec, generate: () => Promise<T>): Promise<T> => {
    // Regeneration never locks — see `mode` on GenerationSpec for why the step
    // status cannot serve as an in-flight lock.
    const step = spec.mode === "regenerate" ? undefined : KIND_STEP[spec.kind];
    const locked = Boolean(step && spec.projectId);
    let prior: (Pick<StepState, "status" | "startedAt"> & { staleReason?: StaleReason }) | null =
      null;

    if (step && spec.projectId) {
      // Deliberately NOT wrapped in try/catch. Its failures — 404, 403, 400
      // (precondition), 409 (already running) — are exactly what the caller
      // should surface, and every controller already renders them correctly,
      // including the SSE one, which runs this before flushHeaders().
      const project = await this.projects.acquireStep(
        spec.projectId,
        step,
        spec.actor,
        { requires: REQUIRES[step], lockMs: STEP_LOCK_MS }
      );
      const state = project.pipeline[step];
      prior = {
        status: state.status,
        startedAt: state.startedAt ?? null,
        staleReason: state.staleReason,
      };
    }

    // Phase 08 inserts exactly one line here:
    //   await this.billing.debit(spec.actor, CREDIT_COSTS[spec.kind]);

    try {
      const out = await generate();
      console.log(
        JSON.stringify({
          event: "generation_ok",
          kind: spec.kind,
          projectId: spec.projectId ?? null,
          userId: spec.actor.userId,
          locked,
        })
      );
      return out;
    } catch (error) {
      // Phase 08 inserts exactly one line here:
      //   await this.billing.refund(spec.actor, CREDIT_COSTS[spec.kind]);

      if (step && spec.projectId && prior) {
        // Best-effort: a failed rollback must not replace the real error with a
        // secondary one. It is logged loudly because a stuck in_progress step
        // blocks the user for STEP_LOCK_MS.
        await this.projects
          .releaseStep(spec.projectId, step, prior)
          .catch((releaseError) =>
            console.error(
              JSON.stringify({
                event: "step_release_failed",
                kind: spec.kind,
                step,
                projectId: spec.projectId,
                message: (releaseError as Error)?.message,
              })
            )
          );
      }

      console.error(
        JSON.stringify({
          event: "generation_failed",
          kind: spec.kind,
          projectId: spec.projectId ?? null,
          userId: spec.actor.userId,
          locked,
          message: (error as Error)?.message,
        })
      );
      throw error;
    }
  };
}

export default StepRunner;
