import { KIND_STEP, REQUIRES, STEP_LOCK_MS, } from "../constants/pipeline.js";
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
    constructor(projects) {
        this.projects = projects;
        this.run = async (spec, generate) => {
            // Regeneration never locks — see `mode` on GenerationSpec for why the step
            // status cannot serve as an in-flight lock.
            const step = spec.mode === "regenerate" ? undefined : KIND_STEP[spec.kind];
            const locked = Boolean(step && spec.projectId);
            let prior = null;
            if (step && spec.projectId) {
                // Deliberately NOT wrapped in try/catch. Its failures — 404, 403, 400
                // (precondition), 409 (already running) — are exactly what the caller
                // should surface, and every controller already renders them correctly,
                // including the SSE one, which runs this before flushHeaders().
                const project = await this.projects.acquireStep(spec.projectId, step, spec.actor.userId, { requires: REQUIRES[step], lockMs: STEP_LOCK_MS });
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
                console.log(JSON.stringify({
                    event: "generation_ok",
                    kind: spec.kind,
                    projectId: spec.projectId ?? null,
                    userId: spec.actor.userId,
                    locked,
                }));
                return out;
            }
            catch (error) {
                // Phase 08 inserts exactly one line here:
                //   await this.billing.refund(spec.actor, CREDIT_COSTS[spec.kind]);
                if (step && spec.projectId && prior) {
                    // Best-effort: a failed rollback must not replace the real error with a
                    // secondary one. It is logged loudly because a stuck in_progress step
                    // blocks the user for STEP_LOCK_MS.
                    await this.projects
                        .releaseStep(spec.projectId, step, prior)
                        .catch((releaseError) => console.error(JSON.stringify({
                        event: "step_release_failed",
                        kind: spec.kind,
                        step,
                        projectId: spec.projectId,
                        message: releaseError?.message,
                    })));
                }
                console.error(JSON.stringify({
                    event: "generation_failed",
                    kind: spec.kind,
                    projectId: spec.projectId ?? null,
                    userId: spec.actor.userId,
                    locked,
                    message: error?.message,
                }));
                throw error;
            }
        };
    }
}
export default StepRunner;
