import type { CreditReservation } from "../../src/repository/billing.repository";
import { CREDIT_COSTS } from "../../src/constants/credits";
import { KIND_STEP, REQUIRES } from "../../src/constants/pipeline";
import StepRunner, { GenerationSpec } from "../../src/service/step-runner";
import { IVideoProject, StepName } from "../../src/types/routes/video-project";
import { BadRequest, Forbidden, NotFound } from "../../src/utlils/errors";

/** Service-flow stub only. Real locks/debits/refunds are tested against BillingRepository. */
export function makeTestStepRunner(opts: {
  project: IVideoProject | (() => IVideoProject | Promise<IVideoProject>);
  reject?: Error;
  onAcquire?: (step: StepName) => void;
  onRelease?: (step: StepName, prior: unknown) => void;
}): StepRunner {
  /**
   * Typed against the real `Pick<BillingRepository, "reserve" | "settle">`, so a drift
   * from either signature is a compile error rather than a fake quietly standing in for
   * something it is not. It used to be laundered through
   * `as unknown as BillingRepository`, which hid a `reserve` returning 3 of
   * `CreditReservation`'s 10 required fields — so any service reading `charge.cost`,
   * `charge.token` or `charge.periodStart` was reading undefined in these tests.
   */
  return new StepRunner({
    reserve: async (spec: GenerationSpec): Promise<CreditReservation | null> => {
      if (opts.reject) throw opts.reject;
      const step = spec.mode === "regenerate" ? undefined : KIND_STEP[spec.kind];
      if (!step || !spec.projectId) return null;
      const project = typeof opts.project === "function" ? await opts.project() : opts.project;
      if (!project || project.isDeleted) throw NotFound();
      if (project.accountId !== spec.actor.accountId) throw Forbidden();
      for (const required of REQUIRES[step]) {
        if (project.pipeline[required]?.status !== "completed") throw BadRequest(`${required} must be completed before generating ${step}`);
      }
      opts.onAcquire?.(step);
      return {
        ownerUid: spec.actor.userId,
        accountId: spec.actor.accountId,
        actorUserId: spec.actor.userId,
        periodStart: "2026-09",
        cost: CREDIT_COSTS[spec.kind],
        debited: CREDIT_COSTS[spec.kind] > 0,
        counter: spec.kind,
        lockKey: `${spec.actor.accountId}_${spec.kind}`,
        token: `test-token-${spec.kind}`,
        kind: spec.kind,
        projectId: spec.projectId,
        step,
        prior: project.pipeline[step],
      };
    },
    settle: async (charge: CreditReservation | null, failed: boolean) => {
      if (failed && charge && charge.step) opts.onRelease?.(charge.step, charge.prior);
      return true;
    },
  });
}

/** Service tests isolate billing; repository behaviour tests exercise charging. */
export const unmeteredSteps = { run: async (_spec: unknown, generate: () => Promise<unknown>) => generate() } as StepRunner;
