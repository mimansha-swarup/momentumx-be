jest.mock("../../../src/config/firebase", () => require("../../helpers/fake-firestore").mockFirebase());
jest.mock("../../../src/utlils/ai", () => ({ generateStreamingContent: jest.fn(), collectJson: jest.fn() }));

import HooksService from "../../../src/service/hooks.service";
import VideoProjectService from "../../../src/service/video-project.service";
import StepRunner from "../../../src/service/step-runner";
import BillingRepository from "../../../src/repository/billing.repository";
import HooksRepository from "../../../src/repository/hooks.repository";
import VideoProjectRepository from "../../../src/repository/video-project.repository";
import PackagingRepository from "../../../src/repository/packaging.repository";
import ContentRepository from "../../../src/repository/content.repository";
import AccountRepository from "../../../src/repository/account.repository";
import { collectJson, generateStreamingContent } from "../../../src/utlils/ai";
import { FakeFirestore } from "../../helpers/fake-firestore";

// Independent reviewer: real services, repositories, reservations and fenced
// writes. Only Firestore transport and the paid provider are replaced.
const db: FakeFirestore = require("../../../src/config/firebase").__db;
const actor = { userId: "editor", accountId: "a" };
const hooks = new HooksRepository();
const projects = new VideoProjectService(new VideoProjectRepository(), new ContentRepository(), new PackagingRepository(), hooks, new AccountRepository());
const service = new HooksService(hooks, projects, undefined, new StepRunner(new BillingRepository()), new AccountRepository());
const state = () => db.col("videoProjects").get("p") as any;
const balance = () => db.col("billing").get("payer") as any;

beforeEach(() => {
  jest.useFakeTimers().setSystemTime(new Date("2026-09-26T00:00:00Z"));
  process.env.MONTHLY_CREDIT_ALLOWANCE = "50";
  db.data.clear();
  db.seed("accounts", [{ id: "a", billingOwnerUid: "payer", members: { editor: { role: "editor" } } }]);
  db.seed("videoProjects", [{ id: "p", accountId: "a", createdBy: "editor", hooksId: "missing", selectedHookIndex: 0, packagingId: "pkg", currentStep: "packaging", overallStatus: "completed", isDeleted: false,
    pipeline: Object.fromEntries(["research", "script", "hooks", "title", "packaging"].map(s => [s, { status: "completed", startedAt: null, completedAt: null }])) }]);
  db.seed("packaging", [{ id: "pkg", accountId: "a", isStale: false, itemStatuses: { title: "completed", description: "completed", thumbnail: "completed", shorts: "completed" } }]);
  jest.mocked(collectJson).mockResolvedValue({ hooks: ["one", "two", "three", "four", "five"] });
});
afterEach(() => { jest.restoreAllMocks(); jest.clearAllMocks(); jest.useRealTimers(); });

it("replaces a missing batch, invalidates index zero and downstream outputs, then replays without another charge", async () => {
  const result = await service.generate(actor, "p", "script");
  expect(state()).toMatchObject({ hooksId: result.id, selectedHookIndex: null, pipeline: { hooks: { status: "in_progress" }, title: { status: "stale" }, packaging: { status: "stale" }, script: { status: "completed" } } });
  expect(db.col("packaging").get("pkg")).toMatchObject({ isStale: true, itemStatuses: { title: "stale", description: "stale", thumbnail: "stale", shorts: "stale" } });
  expect(balance()).toMatchObject({ consumed: 1, pendingCharges: {}, generationLocks: {} });
  expect(await service.generate(actor, "p", "script")).toMatchObject({ id: result.id });
  expect(generateStreamingContent).toHaveBeenCalledTimes(1);
  expect(balance().consumed).toBe(1);
});

it.each(["clearSelectedHook", "markStale", "markPackagingDocumentStale", "linkResource"] as const)("failure at %s leaves no charge or visible replacement and a retry succeeds", async method => {
  const failure = jest.spyOn(projects, method).mockRejectedValueOnce(new Error("injected persistence failure"));
  await expect(service.generate(actor, "p", "script")).rejects.toMatchObject({ detail: { charged: false } });
  expect(state().hooksId).toBe("missing");
  expect(balance()).toMatchObject({ consumed: 0, pendingCharges: {}, generationLocks: {} });
  expect(db.col("accounts/a/usage").size).toBe(0);
  failure.mockRestore();
  const recovered = await service.generate(actor, "p", "script");
  expect(state()).toMatchObject({ hooksId: recovered.id, selectedHookIndex: null, pipeline: { hooks: { status: "in_progress" }, title: { status: "stale" }, packaging: { status: "stale" } } });
  expect(balance().consumed).toBe(1);
});

it("revoked editor access after saving refuses the remaining cascade and charge", async () => {
  const save = hooks.save;
  jest.spyOn(hooks, "save").mockImplementation(async (...args) => {
    const saved = await save(...args);
    db.seed("accounts", [{ id: "a", billingOwnerUid: "payer", members: { editor: { role: "viewer" } } }]);
    return saved;
  });
  await expect(service.generate(actor, "p", "script")).rejects.toMatchObject({ statusCode: 403, detail: { charged: false } });
  expect(state()).toMatchObject({ hooksId: "missing", selectedHookIndex: 0 });
  expect(balance().consumed).toBe(0);
});

it("a concurrent recovery cannot enter the provider while the first reservation is live", async () => {
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  jest.mocked(generateStreamingContent).mockImplementationOnce(async () => {
    entered();
    await new Promise<void>(resolve => { release = resolve; });
    return {} as never;
  });
  const first = service.generate(actor, "p", "script");
  await started;
  await expect(service.generate(actor, "p", "script")).rejects.toMatchObject({ statusCode: 409 });
  release();
  await first;
  expect(generateStreamingContent).toHaveBeenCalledTimes(1);
  expect(balance().consumed).toBe(1);
});

it("an exhausted account cannot create an orphan or invalidate previous choices", async () => {
  db.seed("billing", [{ id: "payer", allowance: 50, consumed: 50, periodStart: "2026-09" }]);
  await expect(service.generate(actor, "p", "script")).rejects.toMatchObject({ statusCode: 402 });
  expect(generateStreamingContent).not.toHaveBeenCalled();
  expect(db.col("hooks").size).toBe(0);
  expect(state()).toMatchObject({ hooksId: "missing", selectedHookIndex: 0, pipeline: { hooks: { status: "completed" } } });
});
