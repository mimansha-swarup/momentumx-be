import StepRunner from "../../src/service/step-runner";
import VideoProjectRepository from "../../src/repository/video-project.repository";
import { IVideoProject, StepName } from "../../src/types/routes/video-project";
import { BadRequest, Conflict, Forbidden, NotFound } from "../../src/utlils/errors";

/**
 * A StepRunner backed by an in-memory project, for SERVICE-level flow tests.
 *
 * The real `acquireStep` is a Firestore transaction, tested directly against the
 * transaction mock in `tests/unit/repository/step-lock.behaviour.test.ts`. That
 * suite is the AUTHORITY on refusals; this helper only mirrors the observable
 * contract so service flow tests can drive the surrounding flow without reaching
 * for Firestore.
 *
 * Read that distinction literally: an assertion made here about a 400 or a 409 is
 * an assertion about the code below, not about production. It was written that way
 * once — the two service-level lock assertions passed while `acquireStep` had no
 * test at all. Put refusal tests in the repository suite; use this one for what
 * happens AROUND the seam.
 */
export function makeTestStepRunner(opts: {
  /**
   * The project to guard. Accepts a thunk so a suite can hand over the same
   * source the service reads (`() => vpService.getById()`) instead of a snapshot
   * that may be replaced per test.
   */
  project:
    | IVideoProject
    | (() => IVideoProject | Promise<IVideoProject>);
  /** Called with the update the real transaction would have written. */
  onAcquire?: (step: StepName) => void;
  onRelease?: (step: StepName, prior: unknown) => void;
}): StepRunner {
  const projects = {
    acquireStep: async (
      _projectId: string,
      step: StepName,
      userId: string,
      guard: { requires: readonly StepName[]; lockMs: number }
    ): Promise<IVideoProject> => {
      const project =
        typeof opts.project === "function" ? await opts.project() : opts.project;
      if (!project) throw NotFound("Video project not found");
      if (project.isDeleted) throw NotFound("Video project not found");
      if (project.createdBy !== userId) throw Forbidden();

      for (const required of guard.requires) {
        if (project.pipeline[required]?.status !== "completed") {
          throw BadRequest(
            `${required} must be completed before generating ${step}`
          );
        }
      }

      const state = project.pipeline[step];
      const startedMs = state?.startedAt?.toMillis?.() ?? 0;
      if (
        state?.status === "in_progress" &&
        Date.now() - startedMs < guard.lockMs
      ) {
        throw Conflict(`${step} generation already in progress for this project`);
      }

      opts.onAcquire?.(step);
      return project;
    },

    releaseStep: async (_projectId: string, step: StepName, prior: unknown) => {
      opts.onRelease?.(step, prior);
    },
  } as unknown as VideoProjectRepository;

  return new StepRunner(projects);
}
