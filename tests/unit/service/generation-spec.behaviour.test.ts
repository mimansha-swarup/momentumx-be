import type { GenerationKind } from "../../../src/constants/pipeline";
import ExtractService from "../../../src/service/extract.service";
import ExtractRepository from "../../../src/repository/extract.repository";
/**
 * What each public generation operation ASKS the billing seam for.
 *
 * `StepRunner.run(spec, generate)` does nothing on its own: the `spec` decides
 * whether the generation is charged, whether it takes the project's in-flight
 * lock, and whether its writes are token-fenced against a superseding run
 * (`BillingRepository.reserve`). One string literal per call site chooses all of
 * it, and `prefill` is the single value `reserve` short-circuits on its first
 * line — before the membership check, the lock and the debit.
 *
 * `generation-spec-coverage.test.ts` pins those literals by COUNTING them per
 * file, which is blind to the mutation that matters most: swap `"title"` and
 * `"description"` between `generateTitle` and `generateDescription` and the
 * per-file counts are identical, while the two operations charge each other's
 * price (1 vs 2 credits) and fence each other's writes. This suite invokes each
 * operation and reads the spec the seam was actually handed.
 *
 * The recording runner deliberately NEVER calls its `generate` callback. The spec
 * is chosen before the generator runs, so skipping it keeps each case to the code
 * under test — no model, no Firestore, and no reason for this suite to fail for a
 * reason that has nothing to do with the spec.
 */

jest.mock("../../../src/config/firebase", () => ({
  db: {},
  auth: {},
  firebase: { firestore: { FieldValue: { serverTimestamp: jest.fn() } } },
}));
jest.mock("../../../src/config/ai", () => ({
  __esModule: true,
  default: jest.fn(),
  embeddingModel: { embedContent: jest.fn() },
}));
jest.mock("../../../src/utlils/ai", () => ({
  generateContent: jest.fn(),
  generateStreamingContent: jest.fn(),
  collectJson: jest.fn(),
}));
// Real, except the one YouTube round-trip in front of the prefill generation.
jest.mock("../../../src/utlils/content", () => ({
  ...jest.requireActual("../../../src/utlils/content"),
  resolveChannel: jest.fn(async () => ({
    id: "chan-1",
    description: "a channel",
    titles: ["t"],
  })),
}));
jest.mock("../../../src/repository/user.repository");
jest.mock("../../../src/repository/extract.repository");

import ContentService from "../../../src/service/content.service";
import HooksService from "../../../src/service/hooks.service";
import PackagingService from "../../../src/service/packaging.service";
import UserService from "../../../src/service/user.service";
import UserRepository from "../../../src/repository/user.repository";
import StepRunner, { GenerationSpec } from "../../../src/service/step-runner";
import VideoProjectService from "../../../src/service/video-project.service";
import { fakeAccountRepo, TEST_ACCOUNT_ID, testOwner } from "../../helpers/account";

const OWNER = testOwner("user-1");
const PROJECT_ID = "proj-1";

/** The spec recorded, and the generator deliberately not run. */
const recorder = () => {
  const specs: GenerationSpec[] = [];
  const runner = {
    run: async (spec: GenerationSpec) => {
      specs.push(spec);
      return undefined;
    },
  } as unknown as StepRunner;
  return { specs, runner };
};

const project = () => ({
  id: PROJECT_ID,
  accountId: TEST_ACCOUNT_ID,
  createdBy: "user-1",
  title: "My Video",
  ideaId: "idea-1",
  scriptId: null,
  hooksId: null,
  isDeleted: false,
  pipeline: {
    research: { status: "completed" },
    script: { status: "completed" },
    hooks: { status: "not_started" },
    title: { status: "not_started" },
    packaging: { status: "not_started" },
  },
});

const vpStub = () =>
  ({
    getById: jest.fn(async () => project()),
    linkResource: jest.fn(async () => undefined),
    completeStep: jest.fn(async () => undefined),
  }) as unknown as VideoProjectService;

/** Enough of an Express response for the SSE path to reach the seam. */
const fakeRes = () =>
  ({
    setHeader: jest.fn(),
    flushHeaders: jest.fn(),
    write: jest.fn(),
    end: jest.fn(),
    headersSent: false,
  }) as never;

const contentService = (runner: StepRunner, repo: Record<string, unknown> = {}) =>
  new ContentService(
    {
      getActiveBatch: jest.fn(async () => []),
      getIdea: jest.fn(async () => ({ id: "idea-1", accountId: TEST_ACCOUNT_ID, title: "My Idea" })),
      getScriptById: jest.fn(async () => ({
        id: "script-1",
        accountId: TEST_ACCOUNT_ID,
        title: "My Script",
        videoProjectId: PROJECT_ID,
      })),
      ...repo,
    } as never,
    new UserRepository() as never,
    vpStub(),
    fakeAccountRepo(),
    undefined,
    runner
  );

const hooksService = (runner: StepRunner) =>
  new HooksService(
    {
      findById: jest.fn(async () => ({
        id: "hooks-1",
        accountId: TEST_ACCOUNT_ID,
        videoProjectId: PROJECT_ID,
        hooks: ["a", "b", "c", "d", "e"],
      })),
      save: jest.fn(),
      update: jest.fn(),
    } as never,
    vpStub(),
    undefined,
    runner,
    fakeAccountRepo()
  );

const packagingService = (runner: StepRunner) =>
  new PackagingService(
    {
      get: jest.fn(async () => ({
        id: "pkg-1",
        accountId: TEST_ACCOUNT_ID,
        videoProjectId: PROJECT_ID,
        itemStatuses: {},
      })),
    } as never,
    vpStub(),
    {
      assemble: jest.fn(async () => ({
        channelContext: { niche: "cooking" },
        sessionContext: { script: "a script", selectedHook: "a hook", workingTitle: "T" },
      })),
    } as never,
    fakeAccountRepo(),
    undefined,
    runner
  );

/**
 * Every public operation that spends a generation, with the spec it owes the
 * seam. `projectId` is part of the contract, not decoration: `reserve` returns
 * without taking the project lock when it is absent, so an operation that forgets
 * to forward it generates unlocked and unfenced.
 */
const OPERATIONS: {
  label: string;
  // The UNION, not `string`. Widening it is what let an operation name a kind that does
  // not exist, and made `CREDIT_COSTS[kind]` silently `any`.
  kind: GenerationKind;
  mode?: string;
  projectId?: string;
  invoke: (runner: StepRunner) => Promise<unknown>;
}[] = [
  {
    label: "POST /v1/ideas/generate",
    kind: "ideas",
    invoke: (runner) => contentService(runner).generateIdeas(OWNER),
  },
  {
    label: "POST /v1/ideas/regenerate-all",
    kind: "ideas",
    invoke: (runner) => contentService(runner).regenerateAll(OWNER),
  },
  {
    label: "POST /v1/ideas/:ideaId/regenerate",
    kind: "ideas",
    invoke: (runner) => contentService(runner).regenerateOne(OWNER, "idea-1"),
  },
  {
    label: "GET /v1/scripts/stream/:projectId",
    kind: "script",
    projectId: PROJECT_ID,
    invoke: (runner) => contentService(runner).generateScripts(OWNER, PROJECT_ID, fakeRes()),
  },
  {
    label: "POST /v1/scripts/:scriptId/regenerate",
    kind: "script",
    mode: "regenerate",
    projectId: PROJECT_ID,
    invoke: (runner) => contentService(runner).regenerateScript(OWNER, "script-1"),
  },
  {
    label: "POST /v1/hooks/generate",
    kind: "hooks",
    projectId: PROJECT_ID,
    invoke: (runner) => hooksService(runner).generate(OWNER, PROJECT_ID, "a script"),
  },
  {
    label: "POST /v1/hooks/:hooksId/regenerate",
    kind: "hooks",
    mode: "regenerate",
    projectId: PROJECT_ID,
    invoke: (runner) => hooksService(runner).regenerate(OWNER, "hooks-1", "a script"),
  },
  {
    label: "POST /v1/packaging/generate-title",
    kind: "title",
    projectId: PROJECT_ID,
    invoke: (runner) => packagingService(runner).generateTitle(OWNER, "a script", PROJECT_ID),
  },
  {
    label: "POST /v1/packaging/generate-description",
    kind: "description",
    projectId: PROJECT_ID,
    invoke: (runner) =>
      packagingService(runner).generateDescription(OWNER, "a script", "A title", PROJECT_ID),
  },
  {
    label: "POST /v1/packaging/generate-thumbnail",
    kind: "thumbnail",
    projectId: PROJECT_ID,
    invoke: (runner) =>
      packagingService(runner).generateThumbnail(OWNER, "a script", "A title", PROJECT_ID),
  },
  {
    label: "POST /v1/packaging/generate-shorts",
    kind: "shorts",
    projectId: PROJECT_ID,
    invoke: (runner) => packagingService(runner).generateShorts(OWNER, "a script", 60, PROJECT_ID),
  },
  {
    label: "POST /v1/user/onboarding/prefill",
    kind: "prefill",
    invoke: (runner) =>
      new UserService(new UserRepository() as never, fakeAccountRepo(), runner,
        new ExtractService(new ExtractRepository()))
        .prefillFromChannel("https://youtube.com/@x", OWNER),
  },
];

describe.each(OPERATIONS.map((op) => [op.label, op] as const))(
  "%s",
  (_label, op) => {
    it(`asks the seam for exactly one "${op.kind}" generation`, async () => {
      const { specs, runner } = recorder();

      await op.invoke(runner);

      expect(specs.map((spec) => spec.kind)).toEqual([op.kind]);
    });

    it("forwards the project (the lock) and the mode (the precondition)", async () => {
      const { specs, runner } = recorder();

      await op.invoke(runner);

      expect(specs[0].projectId).toBe(op.projectId);
      expect(specs[0].mode).toBe(op.mode);
    });
  }
);

/**
 * The one site whose kind is not a literal: `/:packagingId/regenerate/:item`
 * passes the route param through. `generation-spec-coverage.test.ts` can only
 * record that it exists — which of the four items it becomes is decided at
 * runtime, so it can only be checked by running it.
 */
describe("POST /v1/packaging/:packagingId/regenerate/:item", () => {
  it.each(["title", "description", "thumbnail", "shorts"] as const)(
    "regenerating %s asks the seam for that same kind",
    async (item) => {
      const { specs, runner } = recorder();

      await packagingService(runner).regenerateItem(OWNER, "pkg-1", item, "a script", "A title", 60);

      expect(specs).toHaveLength(1);
      expect(specs[0]).toMatchObject({
        kind: item,
        mode: "regenerate",
        projectId: PROJECT_ID,
      });
    }
  );

  it("refuses an item the pricing table has no price for", async () => {
    // The narrowing `item as PackagingItemName` is a cast, not a check — the
    // guard in front of it is. Without it an unknown item reaches `reserve` as a
    // kind with no price, which is a free, unlocked generation.
    const { specs, runner } = recorder();

    await expect(
      packagingService(runner).regenerateItem(OWNER, "pkg-1", "prefill", "a script", "A title")
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(specs).toEqual([]);
  });
});
