jest.mock("../../../src/config/firebase", () => require("../../helpers/fake-firestore").mockFirebase());

import BillingRepository from "../../../src/repository/billing.repository";
import ContentRepository from "../../../src/repository/content.repository";
import HooksRepository from "../../../src/repository/hooks.repository";
import PackagingRepository from "../../../src/repository/packaging.repository";
import { generationWrite } from "../../../src/repository/generation-guard";
import StepRunner from "../../../src/service/step-runner";
import { FakeFirestore, FakeTxn } from "../../helpers/fake-firestore";

const store: FakeFirestore = require("../../../src/config/firebase").__db;
const actor = { userId: "editor", accountId: "channel" };
const billing = new BillingRepository();
const content = new ContentRepository();
const hooks = new HooksRepository();
const packaging = new PackagingRepository();
const balance = () => store.col("billing").get("payer") as any;
const project = () => store.col("videoProjects").get("project") as any;
const usage = (period = "2026-09") => store.col("accounts/channel/usage").get(period) as any;

beforeEach(() => {
  jest.useFakeTimers().setSystemTime(new Date("2026-09-26T00:00:00Z"));
  process.env.MONTHLY_CREDIT_ALLOWANCE = "50";
  store.data.clear();
  store.seed("accounts", [{ id: "channel", billingOwnerUid: "payer", members: { editor: { role: "editor" } } }]);
  store.seed("videoProjects", [{ id: "project", accountId: "channel", currentStep: "packaging", pipeline: {
    research: { status: "completed" }, script: { status: "completed" }, hooks: { status: "completed" }, title: { status: "completed" }, packaging: { status: "not_started" },
  } }]);
  jest.spyOn(console, "error").mockImplementation(() => {});
  jest.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => { jest.useRealTimers(); jest.restoreAllMocks(); });

it("returns saved output and charges once even if every later settlement fails across process replacement and lock expiry", async () => {
  const settle = jest.spyOn(billing, "settle").mockRejectedValue(new Error("persistent outage"));
  const provider = jest.fn(async () => "a usable script");
  let receipt: Awaited<ReturnType<BillingRepository["reserve"]>>;
  const out = await new StepRunner(billing).run({ actor, kind: "script", projectId: "project", mode: "regenerate" }, async charge => {
    receipt = charge;
    const script = await provider();
    await content.saveScript("saved-script", { script, accountId: actor.accountId, videoProjectId: "project" }, charge);
    return script;
  });
  expect(out).toBe("a usable script");
  expect(provider).toHaveBeenCalledTimes(1);
  expect(project().scriptId).toBe("saved-script");
  expect(balance().consumed).toBe(receipt!.cost);
  expect(usage()).toEqual({ credits: receipt!.cost, scripts: 1 });
  for (let n = 0; n < 3; n++) await expect(billing.settle(receipt!, false)).rejects.toThrow("persistent outage");
  settle.mockRestore();

  // No in-memory recovery state is needed: the persisted artifact already owns
  // its accounting, and another instance can safely prune expired reservations.
  jest.advanceTimersByTime(181_000);
  const next = await new BillingRepository().reserve({ actor, kind: "ideas" });
  expect(balance().pendingCharges[receipt!.token]).toBeUndefined();
  expect(await new BillingRepository().settle(receipt!, false)).toBe(false);
  expect(balance().consumed).toBe(receipt!.cost);
  expect(usage()).toEqual({ credits: receipt!.cost, scripts: 1 });
  await billing.settle(next, true);
});

it.each(["ideas", "hooks", "title"] as const)("commits %s artifact, resource pointer where applicable, credits and usage together", async kind => {
  const charge = await billing.reserve({ actor, kind, ...(kind === "ideas" ? {} : { projectId: "project", mode: "regenerate" as const }) });
  if (kind === "ideas") await content.batchSaveIdeas([{ id: "idea", title: "Saved idea", accountId: actor.accountId }], charge);
  if (kind === "hooks") {
    const saved = await hooks.save({ videoProjectId: "project", accountId: actor.accountId, createdBy: "editor", hooks: ["Saved hook"], hookFeedback: {} }, charge);
    expect(project().hooksId).toBe(saved.id);
  }
  if (kind === "title") {
    await packaging.upsertGeneratedItem("project", actor, "titles", "title", ["Saved title"], charge);
    expect(project().packagingId).toBe("project");
  }
  expect(balance().consumed).toBe(charge!.cost);
  expect(usage()).toEqual({ credits: charge!.cost, [charge!.counter]: 1 });
  expect(await billing.settle(charge, false)).toBe(true);
  expect(await billing.settle(charge, false)).toBe(false);
  expect(balance().consumed).toBe(charge!.cost);
  expect(usage()[charge!.counter]).toBe(1);
});

it("rolls back both output and accounting when an artifact transaction cannot commit, then retries once", async () => {
  const charge = await billing.reserve({ actor, kind: "script", projectId: "project", mode: "regenerate" });
  store.seed("scripts", [{ id: "script", script: "old script" }]);
  const original = store.runTransaction.bind(store);
  const fail = jest.spyOn(store, "runTransaction").mockImplementationOnce(fn => original(async tx => {
    // Execute every read and staged write, but abort the whole commit.
    await fn(tx);
    throw new Error("ABORTED");
  }));
  await expect(content.editScript("script", { script: "new script" }, charge)).rejects.toThrow("ABORTED");
  fail.mockRestore();
  expect(store.col("scripts").get("script")!.script).toBe("old script");
  expect(balance().consumed).toBe(0);
  expect(usage()).toBeUndefined();
  await content.editScript("script", { script: "new script" }, charge);
  await content.editScript("script", { script: "new script" }, charge);
  expect(balance().consumed).toBe(charge!.cost);
  expect(usage()).toEqual({ credits: charge!.cost, scripts: 1 });
  // A caller's later bookkeeping failure cannot roll back delivered accounting
  // or advertise the already delivered generation as uncharged.
  expect(await billing.settle(charge, true)).toBe(false);
  expect(balance().consumed).toBe(charge!.cost);
});

it("does not reserve delivered credits twice while lock cleanup is unavailable", async () => {
  process.env.MONTHLY_CREDIT_ALLOWANCE = "4";
  const first = await billing.reserve({ actor, kind: "ideas" });
  await content.batchSaveIdeas([{ id: "idea", title: "Saved" }], first);
  const second = await billing.reserve({ actor, kind: "title", projectId: "project", mode: "regenerate" });
  expect(second!.cost).toBe(1);
  expect(balance().consumed).toBe(3);
  await expect(billing.reserve({ actor, kind: "thumbnail", projectId: "project" })).rejects.toMatchObject({ statusCode: 402 });
});

it("keeps disabled metering disabled even when enforcement is enabled between reservation and delivery", async () => {
  delete process.env.MONTHLY_CREDIT_ALLOWANCE;
  const charge = await billing.reserve({ actor, kind: "ideas" });
  process.env.MONTHLY_CREDIT_ALLOWANCE = "0";
  await content.batchSaveIdeas([{ id: "idea", title: "Saved" }], charge);
  expect(balance().consumed).toBe(0);
  expect(usage()).toEqual({ credits: charge!.cost, ideas: 1 });
  await billing.settle(charge, false);
  expect(usage().ideas).toBe(1);
});

it("does not bill a previous-period delivered run against the new period or duplicate old usage on cleanup", async () => {
  jest.setSystemTime(new Date("2026-09-30T23:59:30Z"));
  const charge = await billing.reserve({ actor, kind: "ideas" });
  jest.setSystemTime(new Date("2026-10-01T00:00:10Z"));
  await billing.getBalance(actor);
  await content.batchSaveIdeas([{ id: "idea", title: "Saved" }], charge);
  expect(balance()).toMatchObject({ consumed: 0, periodStart: "2026-10" });
  expect(usage()).toEqual({ credits: charge!.cost, ideas: 1 });
  expect(usage("2026-10")).toBeUndefined();
  await billing.settle(charge, false);
  expect(usage().ideas).toBe(1);
});

it("rejects a stale writer after an expired reservation is swept, leaving old output and usage intact", async () => {
  const old = await billing.reserve({ actor, kind: "script", projectId: "project", mode: "regenerate" });
  store.seed("scripts", [{ id: "script", script: "old valid script" }]);
  jest.advanceTimersByTime(181_000);
  await billing.reserve({ actor, kind: "ideas" });
  await expect(content.editScript("script", { script: "stale output" }, old)).rejects.toMatchObject({ statusCode: 409 });
  expect(store.col("scripts").get("script")!.script).toBe("old valid script");
  expect(balance().consumed).toBe(0);
  expect(usage()).toBeUndefined();
});

it("leaves pre-delivery metadata writes and empty idea batches uncharged, with all delivery reads before writes", async () => {
  const charge = await billing.reserve({ actor, kind: "ideas" });
  await generationWrite(charge!, tx => tx.update(store.collection("accounts").doc("channel") as any, { note: "preparation" }));
  await content.batchSaveIdeas([], charge);
  expect(balance().consumed).toBe(0);
  expect(usage()).toBeUndefined();
  const original = store.runTransaction.bind(store);
  jest.spyOn(store, "runTransaction").mockImplementation(fn => original(async tx => {
    let wrote = false;
    const guarded: FakeTxn = { ...tx,
      get: async ref => { expect(wrote).toBe(false); return tx.get(ref); },
      set: (...args) => { wrote = true; return tx.set(...args); },
      update: (...args) => { wrote = true; return tx.update(...args); },
    };
    return fn(guarded);
  }));
  await content.batchSaveIdeas([{ id: "idea", title: "Saved" }], charge);
  expect(balance().consumed).toBe(charge!.cost);
});

it("never reports a delivered paid attempt uncharged after cleanup, lock pruning or process replacement", async () => {
  const charge = await billing.reserve({ actor, kind: "ideas" });
  await content.batchSaveIdeas([{ id: "idea", title: "Saved" }], charge);
  await billing.settle(charge, false);
  // A different process can receive an old reservation without the local hint.
  const replay = { ...charge!, outputPersisted: undefined };
  expect(await new BillingRepository().settle(replay, true)).toBe(false);
  jest.advanceTimersByTime(181_000);
  const other = await billing.reserve({ actor, kind: "title", projectId: "project", mode: "regenerate" });
  expect(await new BillingRepository().settle(replay, true)).toBe(false);
  expect(balance().consumed).toBe(charge!.cost);
  expect(usage()).toEqual({ credits: charge!.cost, ideas: 1 });
  await billing.settle(other, true);
});

it.each(["title", "description", "thumbnail", "shorts"] as const)("requires successful settlement before returning unsaved %s output", async kind => {
  const failure = jest.spyOn(billing, "settle").mockRejectedValue(new Error("settlement outage"));
  const provider = jest.fn(async () => "unsaved provider output");
  let charge: Awaited<ReturnType<BillingRepository["reserve"]>>;
  await expect(new StepRunner(billing).run({ actor, kind }, async reservation => {
    charge = reservation;
    return provider();
  })).rejects.toMatchObject({ statusCode: 503 });
  expect(provider).toHaveBeenCalledTimes(1);
  expect(balance().consumed).toBe(0);
  expect(usage()).toBeUndefined();
  expect(balance().pendingCharges[charge!.token]).toBeDefined();
  failure.mockRestore();
  // Settlement retry is independent of the provider, and remains exactly once.
  expect(await new BillingRepository().settle(charge!, false)).toBe(true);
  expect(await new BillingRepository().settle(charge!, false)).toBe(false);
  expect(balance().consumed).toBe(charge!.cost);
});

it("rolls back old hook selection, downstream freshness and output together if delivery aborts", async () => {
  Object.assign(project(), { hooksId: "old-hooks", selectedHookIndex: 0, packagingId: "old-package" });
  store.seed("hooks", [{ id: "old-hooks", hooks: ["old usable hook"] }]);
  store.seed("packaging", [{ id: "old-package", accountId: actor.accountId, isStale: false, itemStatuses: { title: "completed", description: "completed" } }]);
  const charge = await billing.reserve({ actor, kind: "hooks", projectId: "project", mode: "regenerate" });
  const original = store.runTransaction.bind(store);
  const fail = jest.spyOn(store, "runTransaction").mockImplementationOnce(fn => original(async tx => {
    await fn(tx);
    throw new Error("ABORTED");
  }));
  await expect(hooks.update("old-hooks", { hooks: ["new hook"] }, charge)).rejects.toThrow("ABORTED");
  fail.mockRestore();
  expect(store.col("hooks").get("old-hooks")!.hooks).toEqual(["old usable hook"]);
  expect(project()).toMatchObject({ hooksId: "old-hooks", selectedHookIndex: 0, pipeline: { title: { status: "completed" } } });
  expect(store.col("packaging").get("old-package")).toMatchObject({ isStale: false, itemStatuses: { title: "completed" } });
  expect(balance().consumed).toBe(0);
  expect(usage()).toBeUndefined();
});


it("refuses foreign packaging references without modifying either channel or charging", async () => {
  Object.assign(project(), { hooksId: "old-hooks", selectedHookIndex: 0, packagingId: "foreign-package" });
  store.seed("hooks", [{ id: "old-hooks", hooks: ["old usable hook"] }]);
  store.seed("packaging", [{ id: "foreign-package", accountId: "another-channel", isStale: false }]);
  const charge = await billing.reserve({ actor, kind: "hooks", projectId: "project", mode: "regenerate" });
  await expect(hooks.update("old-hooks", { hooks: ["new hook"] }, charge)).rejects.toMatchObject({ statusCode: 403 });
  expect(store.col("hooks").get("old-hooks")!.hooks).toEqual(["old usable hook"]);
  expect(store.col("packaging").get("foreign-package")!.isStale).toBe(false);
  expect(project().selectedHookIndex).toBe(0);
  expect(balance().consumed).toBe(0);
  expect(usage()).toBeUndefined();
});

it("reopens hook selection without staling downstream work that was never started", async () => {
  Object.assign(project(), { hooksId: "old-hooks", selectedHookIndex: 0 });
  project().pipeline.title.status = "not_started";
  project().pipeline.packaging.status = "not_started";
  store.seed("hooks", [{ id: "old-hooks", hooks: ["old usable hook"] }]);
  const charge = await billing.reserve({ actor, kind: "hooks", projectId: "project", mode: "regenerate" });
  await hooks.update("old-hooks", { hooks: ["new hook"] }, charge);
  expect(project()).toMatchObject({ selectedHookIndex: null, overallStatus: "in_progress", pipeline: { hooks: { status: "in_progress" }, title: { status: "not_started" }, packaging: { status: "not_started" } } });
  expect(project().pipeline.title.staleReason).toBeUndefined();
  expect(balance().consumed).toBe(charge!.cost);
});
