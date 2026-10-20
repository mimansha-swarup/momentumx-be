jest.mock("../../../src/config/firebase", () => require("../../helpers/fake-firestore").mockFirebase());

import BillingRepository from "../../../src/repository/billing.repository";
import VideoProjectRepository from "../../../src/repository/video-project.repository";
import StepRunner from "../../../src/service/step-runner";
import { FakeFirestore, FakeTxn } from "../../helpers/fake-firestore";
import { ServiceUnavailable } from "../../../src/utlils/errors";

const store: FakeFirestore = require("../../../src/config/firebase").__db;
const repo = new BillingRepository();
const actor = { userId: "editor", accountId: "account-a" };
const initial = () => ({ id: "project-a", accountId: "account-a", currentStep: "packaging", pipeline: {
  research: { status: "completed" }, script: { status: "completed" }, hooks: { status: "in_progress", startedAt: 1 }, title: { status: "completed" }, packaging: { status: "not_started" },
} });
const balance = () => store.col("billing").get("payer") as any;
const usage = (period = "2026-09") => store.col("accounts/account-a/usage").get(period) as any;

beforeEach(() => {
  jest.useFakeTimers().setSystemTime(new Date("2026-09-26T00:00:00Z"));
  process.env.MONTHLY_CREDIT_ALLOWANCE = "50";
  store.data.clear();
  store.seed("accounts", [{ id: "account-a", billingOwnerUid: "payer", members: { editor: { role: "editor" } } }, { id: "account-b", billingOwnerUid: "payer", members: { editor: { role: "editor" } } }]);
  store.seed("videoProjects", [initial()]);
});
afterEach(() => {
  jest.useRealTimers();
  // Several tests spy on store.runTransaction and restore it on their LAST line,
  // so any earlier assertion failure leaked the spy into every test after it —
  // one genuine failure surfaced as twenty timeouts and hid its own cause.
  jest.restoreAllMocks();
});

it("reserves up front and charges the channel payer only once content lands", async () => {
  const charge = await repo.reserve({ actor, kind: "ideas" });
  // Nothing is charged yet. Anything that kills the process between here and the
  // save must cost the user nothing, which is the whole point of a reservation.
  expect(balance()).toMatchObject({ allowance: 50, consumed: 0, periodStart: "2026-09" });
  expect(balance().pendingCharges[charge!.token]).toEqual({ periodStart: "2026-09", cost: 3 });
  expect(usage()).toBeUndefined();
  expect(store.col("billing").has("editor")).toBe(false);

  await repo.settle(charge, false);

  expect(balance()).toMatchObject({ consumed: 3 });
  expect(usage()).toMatchObject({ credits: 3, ideas: 1 });
  expect(balance().generationLocks).toEqual({});
  expect(balance().pendingCharges).toEqual({});
});

it("uses one transaction for lock and reservation, with every read before any write", async () => {
  const original = store.runTransaction.bind(store);
  const spy = jest.spyOn(store, "runTransaction").mockImplementation(async fn => original(async txn => {
    let wrote = false;
    const guarded: FakeTxn = { ...txn, get: async ref => { expect(wrote).toBe(false); return txn.get(ref); }, set: (...args) => { wrote = true; return txn.set(...args); }, update: (...args) => { wrote = true; return txn.update(...args); } };
    return fn(guarded);
  }));
  const charge = await repo.reserve({ actor, kind: "hooks", projectId: "project-a", mode: "regenerate" });
  expect(spy).toHaveBeenCalledTimes(1);
  expect(balance().consumed).toBe(0);
  expect(balance().pendingCharges[charge!.token].cost).toBe(1);
  spy.mockRestore();
});

it("serialised concurrent transactions cannot both spend the last credit", async () => {
  store.seed("billing", [{ id: "payer", allowance: 1, consumed: 0, periodStart: "2026-09" }]);
  // The fake has no Firestore contention engine. Serialise transaction commits,
  // the contract Firestore guarantees, and exercise real repository decisions.
  const original = store.runTransaction.bind(store);
  let queue: Promise<any> = Promise.resolve();
  const spy = jest.spyOn(store, "runTransaction").mockImplementation(fn => {
    const run = queue.then(() => original(fn));
    queue = run.catch(() => undefined);
    return run;
  });
  const outcomes = await Promise.allSettled([
    repo.reserve({ actor, kind: "thumbnail" }),
    repo.reserve({ actor: { ...actor, accountId: "account-b" }, kind: "title" }),
  ]);
  expect(outcomes.filter(o => o.status === "fulfilled")).toHaveLength(1);
  expect(outcomes.find(o => o.status === "rejected")).toMatchObject({ reason: { statusCode: 402, code: "insufficient_credits", detail: { resetsAt: "2026-10-01T00:00:00.000Z" } } });
  // The loser is refused because the winner's RESERVATION counts against the
  // balance while its lock is live — an unsettled run must be as good as spent.
  expect(balance().consumed).toBe(0);
  const winner = outcomes.find(o => o.status === "fulfilled") as PromiseFulfilledResult<Awaited<ReturnType<typeof repo.reserve>>>;
  await repo.settle(winner.value, false);
  expect(balance().consumed).toBe(1);
  spy.mockRestore();
});

it("prevents duplicate regenerations, but permits independent packaging items", async () => {
  const hooks = await repo.reserve({ actor, kind: "hooks", projectId: "project-a", mode: "regenerate" });
  await expect(repo.reserve({ actor, kind: "hooks", projectId: "project-a", mode: "regenerate" })).rejects.toMatchObject({ statusCode: 409 });
  const description = await repo.reserve({ actor, kind: "description", projectId: "project-a" });
  const thumbnail = await repo.reserve({ actor, kind: "thumbnail", projectId: "project-a" });
  expect(balance().consumed).toBe(0);

  for (const charge of [hooks, description, thumbnail]) await repo.settle(charge, false);

  expect(balance().consumed).toBe(4);
});

it("rolls back a failed stale generation and charges nothing for it", async () => {
  const p = initial(); p.pipeline.hooks = { status: "stale", startedAt: 123 };
  store.seed("videoProjects", [p]);
  const runner = new StepRunner(repo);
  await expect(runner.run({ actor, kind: "hooks", projectId: "project-a" }, async () => { throw ServiceUnavailable("Empty stream"); })).rejects.toMatchObject({ detail: { charged: false } });
  expect(balance().consumed).toBe(0);
  // Usage counts what was DELIVERED, so a failed run never writes it at all —
  // it no longer has to be incremented and then decremented back to zero.
  expect(usage()).toBeUndefined();
  expect(store.col("videoProjects").get("project-a")?.pipeline).toMatchObject({ hooks: { status: "stale", startedAt: 123 } });
});

it("a failure across a monthly reset charges nothing to the new period", async () => {
  const september = await repo.reserve({ actor, kind: "ideas" });
  jest.setSystemTime(new Date("2026-10-01T00:00:00Z"));
  await repo.getBalance(actor);
  const october = await repo.reserve({ actor, kind: "thumbnail" });

  await repo.settle(september, true);

  expect(balance()).toMatchObject({ periodStart: "2026-10", consumed: 0 });
  await repo.settle(october, false);
  // October's own run is charged to October; September's failure is charged nowhere.
  expect(balance()).toMatchObject({ periodStart: "2026-10", consumed: 1 });
  expect(usage("2026-09")).toBeUndefined();
  expect(usage("2026-10")).toMatchObject({ credits: 1 });
});

it("does not let an expired runner roll back a successor's lock or charge", async () => {
  const spec = { actor, kind: "hooks" as const, projectId: "project-a" };
  const first = await repo.reserve(spec);
  jest.setSystemTime(new Date("2026-09-26T00:04:00Z"));
  const second = await repo.reserve(spec);
  // The successor's reserve already swept the abandoned reservation (it held no
  // money and must not hold a balance slot). Releasing the expired run is then a
  // no-op that still reports truthfully — it was never charged — and stays safe
  // however many times it is retried, because a release moves no money.
  expect(await repo.settle(first, true)).toBe(true);
  expect(await repo.settle(first, true)).toBe(true);
  expect(balance().consumed).toBe(0);
  expect(balance().generationLocks[second!.lockKey].token).toBe(second!.token);
  // The successor is still chargeable, and charged exactly once.
  await repo.settle(second, false);
  expect(balance().consumed).toBe(1);
});

it("refuses a viewer and a project in another account before writing credits", async () => {
  store.seed("accounts", [{ id: "viewer-account", billingOwnerUid: "payer", members: { editor: { role: "viewer" } } }]);
  await expect(repo.reserve({ actor: { ...actor, accountId: "viewer-account" }, kind: "ideas" })).rejects.toMatchObject({ code: "role_forbidden" });
  await expect(repo.reserve({ actor: { ...actor, accountId: "account-b" }, kind: "hooks", projectId: "project-a" })).rejects.toMatchObject({ code: "wrong_account" });
  expect(balance()).toBeUndefined();
});

it("requires starting preconditions but lets regeneration repair stale upstream content", async () => {
  const p = initial(); p.pipeline.script.status = "stale"; store.seed("videoProjects", [p]);
  await expect(repo.reserve({ actor, kind: "hooks", projectId: "project-a" })).rejects.toMatchObject({ statusCode: 400 });
  await expect(repo.reserve({ actor, kind: "hooks", projectId: "project-a", mode: "regenerate" })).resolves.toBeTruthy();
});

it("leaves enforcement disabled until configured while tracking locks and usage", async () => {
  process.env.MONTHLY_CREDIT_ALLOWANCE = "unlimited";
  const generate = jest.fn(async () => "ok");
  const runner = new StepRunner(repo);
  await expect(repo.getBalance(actor)).resolves.toMatchObject({ enabled: false, allowance: null, remaining: null, consumed: 0 });
  await expect(runner.run({ actor, kind: "ideas" }, generate)).resolves.toBe("ok");
  expect(balance().consumed).toBe(0);
  expect(usage()).toMatchObject({ ideas: 1, credits: 3 });
  await expect(runner.run({ actor, kind: "prefill" }, generate)).resolves.toBe("ok");
});

it("configured zero enforces exhaustion, and malformed configuration never disables the gate", async () => {
  process.env.MONTHLY_CREDIT_ALLOWANCE = "0";
  await expect(repo.reserve({ actor, kind: "ideas" })).rejects.toMatchObject({ statusCode: 402 });
  for (const value of ["invalid", "0x10", "1e2", "", "  "]) {
    process.env.MONTHLY_CREDIT_ALLOWANCE = value;
    await expect(repo.reserve({ actor, kind: "ideas" })).rejects.toMatchObject({ statusCode: 503 });
  }
});

it("costs the user nothing when the settle transaction itself fails", async () => {
  // Previously this asserted `consumed` STAYED 3: the debit had already committed
  // and the refund was the only way back, so a failed refund stranded the charge.
  // A reservation cannot strand money, because it never took any.
  const spy = jest.spyOn(repo, "settle").mockRejectedValueOnce(new Error("Firestore unavailable"));
  await expect(new StepRunner(repo).run({ actor, kind: "ideas" }, async () => { throw ServiceUnavailable("No output"); })).rejects.toMatchObject({ message: "No output", detail: undefined });
  expect(balance().consumed).toBe(0);
  spy.mockRestore();
});

it("never recharges a script already linked between replay read and transaction", async () => {
  store.seed("videoProjects", [{ ...initial(), scriptId: "existing-script" }]);
  store.seed("scripts", [{ id: "existing-script", script: "Saved" }]);
  await expect(repo.reserve({ actor, kind: "script", projectId: "project-a" })).rejects.toMatchObject({ statusCode: 409 });
  expect(balance()).toBeUndefined();
});

it("restores a legacy missing title step after failed generation", async () => {
  const p = initial(); delete (p.pipeline as any).title; store.seed("videoProjects", [p]);
  const charge = await repo.reserve({ actor, kind: "title", projectId: "project-a" });
  await repo.settle(charge, true);
  expect(store.col("videoProjects").get("project-a")?.pipeline).toMatchObject({ title: { status: "not_started", startedAt: null } });
});

it("closes the hooks replay race before debit but permits repair of a missing batch", async () => {
  store.seed("videoProjects", [{ ...initial(), hooksId: "batch-a" }]);
  store.seed("hooks", [{ id: "batch-a", hooks: ["saved"] }]);
  await expect(repo.reserve({ actor, kind: "hooks", projectId: "project-a" })).rejects.toMatchObject({ statusCode: 409 });
  expect(balance()).toBeUndefined();
  store.col("hooks").delete("batch-a");
  await expect(repo.reserve({ actor, kind: "hooks", projectId: "project-a" })).resolves.toBeTruthy();
});

it("new default allowances follow configuration, with a separately explicit owner override", async () => {
  await repo.getBalance(actor);
  process.env.MONTHLY_CREDIT_ALLOWANCE = "75";
  await expect(repo.getBalance(actor)).resolves.toMatchObject({ allowance: 75 });
  await store.collection("billing").doc("payer").update({ allowanceOverride: 20 });
  await expect(repo.getBalance(actor)).resolves.toMatchObject({ allowance: 20 });
});

it("prunes abandoned reservations instead of refusing every generation", async () => {
  // 256 receipts with no live lock are 256 crashed runs. Refusing here — the old
  // behaviour, a hard 503 — turned one crash into a total outage of paid
  // generation for this payer for the rest of the month. They hold no money, so
  // they are swept instead.
  const pendingCharges = Object.fromEntries(Array.from({ length: 256 }, (_, i) => [String(i), { cost: 1, periodStart: "2026-09" }]));
  store.seed("billing", [{ id: "payer", allowanceSource: "default", pendingCharges }]);

  const charge = await repo.reserve({ actor, kind: "ideas" });

  expect(charge).toBeTruthy();
  expect(Object.keys(balance().pendingCharges)).toEqual([charge!.token]);
});

it("keeps reservations bounded across months and disabled enforcement", async () => {
  process.env.MONTHLY_CREDIT_ALLOWANCE = "unlimited";
  const free = await repo.reserve({ actor, kind: "ideas" });
  expect(free?.debited).toBe(false);
  await repo.settle(free, false);
  jest.setSystemTime(new Date("2026-11-01T00:00:00Z"));
  process.env.MONTHLY_CREDIT_ALLOWANCE = "50";
  await repo.reserve({ actor, kind: "ideas" });
  expect(Object.keys(balance().pendingCharges)).toHaveLength(1);
});

it("preserves consumed credits while enforcement is temporarily disabled", async () => {
  await repo.settle(await repo.reserve({ actor, kind: "script", projectId: "project-a", mode: "regenerate" }), false);
  process.env.MONTHLY_CREDIT_ALLOWANCE = "unlimited";
  await repo.settle(await repo.reserve({ actor, kind: "ideas" }), false);
  expect(await repo.getBalance(actor)).toMatchObject({ enabled: false, consumed: 5 });
  process.env.MONTHLY_CREDIT_ALLOWANCE = "50";
  expect(await repo.getBalance(actor)).toMatchObject({ enabled: true, remaining: 45 });
});
it("hides the owning channel from a caller who is not its member", async () => {
  store.seed("accounts", [{ id: "account-a", billingOwnerUid: "payer", members: {} }]);
  await expect(repo.reserve({ actor: { ...actor, accountId: "account-b" }, kind: "hooks", projectId: "project-a" })).rejects.toMatchObject({ code: "account_forbidden" });
  expect(balance()).toBeUndefined();
});
it("a failed takeover never rolls completed pipeline progress back", async () => {
  const spec = { actor, kind: "hooks" as const, projectId: "project-a" };
  const first = await repo.reserve(spec);
  jest.advanceTimersByTime(181_000);
  const second = await repo.reserve(spec);
  (store.col("videoProjects").get("project-a") as any).pipeline.hooks.status = "completed";
  await repo.settle(first, false);
  await repo.settle(second, true);
  expect((store.col("videoProjects").get("project-a") as any).pipeline.hooks.status).toBe("completed");
});
it("old payer settlement cannot roll back the new payer's project run", async () => {
  const spec = { actor, kind: "hooks" as const, projectId: "project-a" };
  const first = await repo.reserve(spec);
  jest.advanceTimersByTime(181_000);
  store.col("accounts").get("account-a")!.billingOwnerUid = "new-payer";
  const second = await repo.reserve(spec);
  await repo.settle(first, true);
  expect((store.col("videoProjects").get("project-a") as any).generationLocks.hooks.token).toBe(second!.token);
  expect((store.col("videoProjects").get("project-a") as any).pipeline.hooks.status).toBe("in_progress");
  expect(balance().consumed).toBe(0);
  expect(store.col("billing").get("new-payer")!.consumed).toBe(0);
  await repo.settle(second, false);
  expect(store.col("billing").get("new-payer")!.consumed).toBe(1);
});
it("channel purge removes its usage and preserves other channels and payer balance", async () => {
  const AccountRepository = require("../../../src/repository/account.repository").default;
  await repo.settle(await repo.reserve({ actor, kind: "ideas" }), false);
  store.seed("accounts/account-b/usage", [{ id: "2026-09", credits: 7 }]);
  store.col("accounts").get("account-a")!.deletedAt = new Date();
  await new AccountRepository().purgeAccountData("account-a");
  expect(store.col("accounts/account-a/usage").size).toBe(0);
  expect(store.col("accounts/account-b/usage").get("2026-09")!.credits).toBe(7);
  expect(balance().consumed).toBe(3);
});
it("treats a cleared owner override as no override, loudly, rather than bricking the payer", async () => {
  // This asserted the OPPOSITE: that a null override must be REFUSED so it could
  // not silently become the default. The concern was fair, the cure was not —
  // `getBalance` shares the same validator, so the payer could not even READ
  // their balance, and no API could repair the document. `null` is also exactly
  // what clearing the field in the console produces.
  //
  // Now it falls back to the default and says so in the log, so the write is
  // visible without locking anyone out.
  const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
  store.seed("billing", [{ id: "payer", allowanceOverride: null }]);

  await expect(repo.getBalance(actor)).resolves.toMatchObject({ enabled: true, allowance: 50 });

  expect(warn).toHaveBeenCalledWith(expect.stringContaining("billing_override_cleared"));
});

it("leaves generation available, with enforcement OFF, when no allowance is configured", async () => {
  // THIS TEST USED TO ASSERT THE OPPOSITE (503 on both calls), on the reasoning that an
  // absent env var is indistinguishable from a dropped one and should fail closed. That
  // reasoning is defensible but it is not the decision on record:
  // docs/multi-account/phase-08-credits-and-metering.md says "The user chose enforcement
  // disabled until configured" and "No configured allowance means enabled:false,
  // allowance:null, remaining:null: generation remains available".
  //
  // It matters because unconfigured is the DEFAULT state of an install: throwing broke
  // every balance read, every generation, and free prefill. The documented asymmetry is
  // kept — absent disables, INVALID still fails closed (asserted separately below) — and
  // absent is logged so it is not silent.
  const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
  delete process.env.MONTHLY_CREDIT_ALLOWANCE;

  await expect(repo.getBalance(actor)).resolves.toMatchObject({
    enabled: false,
    allowance: null,
    remaining: null,
  });
  // Generation proceeds; it simply is not metered. The reserve resolves instead of
  // throwing, and nothing is consumed.
  await repo.reserve({ actor, kind: "ideas" });
  await expect(repo.getBalance(actor)).resolves.toMatchObject({ enabled: false, consumed: 0 });

  expect(warn).toHaveBeenCalledWith(
    expect.stringContaining("billing_allowance_unconfigured")
  );
  warn.mockRestore();
});

it.each(["unlimited", "none", "off", "UNLIMITED"])("treats %s as an explicit opt-out", async value => {
  process.env.MONTHLY_CREDIT_ALLOWANCE = value;

  await expect(repo.getBalance(actor)).resolves.toMatchObject({ enabled: false, allowance: null, remaining: null });
  const charge = await repo.reserve({ actor, kind: "ideas" });
  expect(charge?.debited).toBe(false);
});

it("reads a numeric string consumed, which is what a JSON or CSV import writes", async () => {
  // `allowance` has always accepted a numeric string; `consumed` refusing one
  // meant a plausible operator write 503'd the payer on a field the code could
  // simply have read.
  store.seed("billing", [{ id: "payer", allowance: 50, allowanceSource: "default", consumed: "7", periodStart: "2026-09" }]);

  await expect(repo.getBalance(actor)).resolves.toMatchObject({ consumed: 7, remaining: 43 });
});

it("still refuses a consumed value that is not a number at all", async () => {
  store.seed("billing", [{ id: "payer", allowance: 50, allowanceSource: "default", consumed: "lots", periodStart: "2026-09" }]);

  await expect(repo.getBalance(actor)).rejects.toMatchObject({ statusCode: 503 });
});

it("refuses a cross-channel access with 403, even when billing is misconfigured", async () => {
  // A configuration error must never pre-empt an authorization one: evaluating
  // the allowance before the project check answered 503 "not configured" where
  // the honest answer is "you cannot touch that channel".
  delete process.env.MONTHLY_CREDIT_ALLOWANCE;
  store.seed("videoProjects", [{ ...initial(), id: "project-b", accountId: "someone-else" }]);

  await expect(
    repo.reserve({ actor, kind: "hooks", projectId: "project-b" })
  ).rejects.toMatchObject({ statusCode: 403 });
});
it("hides invitations for deleted or orphaned channels from the pending inbox", async () => {
  const SharingRepository = require("../../../src/repository/sharing.repository").default;
  const { Timestamp } = require("firebase-admin/firestore");
  store.seed("accounts", [{ id: "deleted", deletedAt: Timestamp.now() }, { id: "orphan", orphanedAt: Timestamp.now() }]);
  store.seed("invites", ["deleted", "orphan", "account-a"].map(accountId => ({ id: accountId, accountId, email: "editor@example.com", status: "pending", expiresAt: Timestamp.fromMillis(Date.now() + 60_000) })));
  const invitations = await new SharingRepository().pending("editor@example.com", true);
  expect(invitations.map((i: any) => i.accountId)).toEqual(["account-a"]);
});

// The four guards below were covered by tests/unit/repository/step-lock.behaviour.test.ts
// until the lock moved from VideoProjectRepository into BillingRepository.reserve.
// The move relocated most of that suite, but these were dropped: each can be
// deleted from reserve today with all 1243 tests still green (verified by
// mutation). They live here because reserve is now their only enforcement point.
const project = () => store.col("videoProjects").get("project-a") as any;

it("refuses a soft-deleted project, and charges nothing for it", async () => {
  // PackagingService.generate* call steps.run FIRST, with no prior project read,
  // so reserve is their only deletion check. Without it, generating against a
  // deleted project debits credits, takes both locks, and writes in_progress
  // onto the document — resurrecting pipeline state the user deleted.
  project().isDeleted = true;

  await expect(repo.reserve({ actor, kind: "description", projectId: "project-a" })).rejects.toMatchObject({ statusCode: 404 });

  expect(store.col("billing").has("payer")).toBe(false);
  expect(usage()).toBeUndefined();
  expect(project().generationLocks).toBeUndefined();
});

it("does not knock a completed step back to in_progress", async () => {
  // A replay past the 180s lock, or a second create-mode generate-title after
  // the title step finished, would otherwise flip the step back — and only
  // select-title can re-complete it, so the project reads as unfinished forever.
  await repo.reserve({ actor, kind: "title", projectId: "project-a" });

  expect(project().pipeline.title).toEqual({ status: "completed" });
});

it("never rewinds currentStep to an earlier step", async () => {
  // Regenerating hooks on a project already at packaging must not send the
  // dashboard's stepper backwards.
  await repo.reserve({ actor, kind: "hooks", projectId: "project-a" });

  expect(project().pipeline.hooks.status).toBe("in_progress");
  expect(project().currentStep).toBe("packaging");
});

it("advances currentStep when the generation starts a later step", async () => {
  // The other direction, so a guard that simply never writes currentStep fails too.
  project().currentStep = "script";

  await repo.reserve({ actor, kind: "hooks", projectId: "project-a" });

  expect(project().currentStep).toBe("hooks");
});

it("a crash between reserving and settling costs the user nothing", async () => {
  // The decision this encodes. `settle` only ever runs in the same invocation, so
  // anything that kills the process after `reserve` means no settle ever happens
  // — and on the default serverless function budget, against a model call that
  // may take two minutes, that is the ORDINARY outcome for idea generation, not
  // an exotic crash. Debiting up front made those credits simply gone, with no
  // path back before the next monthly reset.
  const abandoned = await repo.reserve({ actor, kind: "script", projectId: "project-a" });
  expect(abandoned).toBeTruthy();

  // Nothing else runs. No settle, no refund, no sweeper.
  expect(balance().consumed).toBe(0);
  expect(usage()).toBeUndefined();

  // Once the lock ages out the retry is admitted, and the user is billed once —
  // for the attempt that actually produced something.
  jest.setSystemTime(new Date("2026-09-26T00:04:00Z"));
  const retry = await repo.reserve({ actor, kind: "script", projectId: "project-a" });
  await repo.settle(retry, false);
  expect(balance().consumed).toBe(5);
  expect(usage()).toMatchObject({ credits: 5, scripts: 1 });
});

it("governs prefill without charging for it", async () => {
  // `prefill` used to return on `reserve`'s FIRST line, before the membership
  // check, the viewer check and the lock. It is free — cost 0, so it passes even
  // for an exhausted payer — but free is not ungoverned: it spends ~101 of a 10k
  // daily YouTube quota plus a Gemini call, and unlocked it could be looped in
  // parallel against distinct URLs (defeating the 6h cache) until the product's
  // whole daily quota was gone.
  store.seed("billing", [{ id: "payer", allowance: 50, allowanceSource: "default", consumed: 50, periodStart: "2026-09" }]);

  const first = await repo.reserve({ actor, kind: "prefill" });

  // Free even at zero remaining...
  expect(first?.debited).toBe(false);
  expect(balance().consumed).toBe(50);
  // ...but one at a time per channel.
  await expect(repo.reserve({ actor, kind: "prefill" })).rejects.toMatchObject({ statusCode: 409 });
  await repo.settle(first, false);
  await expect(repo.reserve({ actor, kind: "prefill" })).resolves.toBeTruthy();
});

it("refuses prefill to a viewer, like any other generation", async () => {
  store.seed("accounts", [{ id: "viewer-account", billingOwnerUid: "payer", members: { editor: { role: "viewer" } } }]);

  await expect(
    repo.reserve({ actor: { ...actor, accountId: "viewer-account" }, kind: "prefill" })
  ).rejects.toMatchObject({ code: "role_forbidden" });
});

it("files title spend in its own bucket, not with packaging", async () => {
  // `title` is its own pipeline step with its own price. Folding it in meant
  // `usage/{month}.packaging` counted four different actions and could not be
  // reconciled with what the user did.
  await repo.settle(await repo.reserve({ actor, kind: "title", projectId: "project-a" }), false);
  await repo.settle(await repo.reserve({ actor, kind: "description", projectId: "project-a" }), false);

  expect(usage()).toMatchObject({ title: 1, packaging: 1, credits: 3 });
});

it("takes its lock time from the server, not from this host's clock", async () => {
  // `startedAt` was `Date.now()` from whichever instance took the lock, and every
  // other instance compared it against its own clock: a writer five minutes fast
  // held its lock for eight minutes after dying, a slow one let a successor in
  // early. The fake resolves the sentinel to a plain number, so the assertion is
  // that the value comes from the sentinel FACTORY — which is the thing that was
  // wrong — rather than from the local clock.
  const { firebase } = require("../../../src/config/firebase");
  jest.spyOn(firebase.firestore.FieldValue, "serverTimestamp").mockReturnValue(424242 as never);

  const charge = await repo.reserve({ actor, kind: "hooks", projectId: "project-a", mode: "regenerate" });

  expect(balance().generationLocks[charge!.lockKey].startedAt).toBe(424242);
  expect(Date.now()).not.toBe(424242);
});

it("still reads a legacy numeric lock time, so old locks keep expiring", async () => {
  // Locks written before the change stored epoch millis. Rejecting them would
  // make every one of them look infinitely old, or infinitely young.
  store.seed("billing", [{
    id: "payer", allowance: 50, allowanceSource: "default", periodStart: "2026-09",
    generationLocks: { "account-a_project-a_hooks": { token: "old", startedAt: Date.now() - 1000 } },
  }]);

  // Fresh by the legacy reading, so it still blocks.
  await expect(
    repo.reserve({ actor, kind: "hooks", projectId: "project-a", mode: "regenerate" })
  ).rejects.toMatchObject({ statusCode: 409 });

  jest.setSystemTime(new Date("2026-09-26T00:04:00Z"));
  await expect(
    repo.reserve({ actor, kind: "hooks", projectId: "project-a", mode: "regenerate" })
  ).resolves.toBeTruthy();
});

it("does not recharge a packaging item that already landed", async () => {
  // Only `script` and `hooks` had a replay guard. A lost response on
  // `generate-description` — the item saved, the reply dropped — recharged 2
  // credits on retry and overwrote the same single field, so the user paid twice
  // for one artifact. Deliberate regeneration is a different route.
  store.seed("packaging", [{ id: "project-a", accountId: "account-a", itemStatuses: { description: "completed" } }]);

  await expect(
    repo.reserve({ actor, kind: "description", projectId: "project-a" })
  ).rejects.toMatchObject({ statusCode: 409 });

  expect(balance()?.consumed ?? 0).toBe(0);
  // Regeneration is explicitly allowed — it is what the user asked for.
  await expect(
    repo.reserve({ actor, kind: "description", projectId: "project-a", mode: "regenerate" })
  ).resolves.toBeTruthy();
});

it("still allows the first generation of an item the project has not produced", async () => {
  store.seed("packaging", [{ id: "project-a", accountId: "account-a", itemStatuses: { description: "completed" } }]);

  await expect(
    repo.reserve({ actor, kind: "thumbnail", projectId: "project-a" })
  ).resolves.toBeTruthy();
});

it("refuses to persist a stale run whose receipt an unrelated same-payer reservation swept, so it is never silently unbilled", async () => {
  // 1. Generation A reserves for project-a's hooks step: a receipt lands in
  //    billing/payer.pendingCharges[tokenA], and a lock lands on BOTH the
  //    billing doc (keyed by lockKey) and the project doc (keyed by kind).
  const chargeA = await repo.reserve({ actor, kind: "hooks", projectId: "project-a" });
  expect(chargeA?.debited).toBe(true);

  // 2. A's lock ages past STEP_LOCK_MS (180s) — a slow generation.
  jest.setSystemTime(new Date("2026-09-26T00:04:00Z"));

  // 3. An UNRELATED generation B reserves for the SAME payer — account-b shares
  //    billingOwnerUid "payer" with account-a. `reserve`'s pruning is payer-wide:
  //    A's now-abandoned billing-doc lock and receipt are swept. A's PROJECT lock
  //    is untouched — B has no projectId, so it never writes to project-a at all.
  const chargeB = await repo.reserve({ actor: { ...actor, accountId: "account-b" }, kind: "ideas" });
  expect(chargeB).toBeTruthy();
  expect(balance().pendingCharges[chargeA!.token]).toBeUndefined();
  expect(project().generationLocks.hooks.token).toBe(chargeA!.token);

  // 4 & 5. A finishes and tries to persist. The project lock alone still matches,
  // so a guard that only checks it would let this write through: content saved,
  // no receipt to charge, no usage recorded. The billing-side check must refuse it.
  await expect(
    new VideoProjectRepository().update("project-a", { title: "New Title" }, chargeA)
  ).rejects.toMatchObject({ statusCode: 409 });
  expect(project().title).toBeUndefined();
});

// ─── Successful-settlement idempotency ──────────────────────────────────────
// `settle` promises exactly-once CHARGING: the receipt is the token that permits
// a charge, and settling consumes it. Everything above settles the same
// reservation repeatedly only on the FAILURE path — which moves no money, so it
// is the half that cannot double anything. These settle it SUCCESSFULLY twice.

/** Firestore serialises transaction commits; this fake runs them interleaved. */
const serialised = () => {
  const original = store.runTransaction.bind(store);
  let queue: Promise<unknown> = Promise.resolve();
  return jest.spyOn(store, "runTransaction").mockImplementation(fn => {
    const run = queue.then(() => original(fn));
    queue = run.catch(() => undefined);
    return run;
  });
};

/**
 * Run the callback once with every write DISCARDED — what Firestore does to an
 * attempt it aborts on contention — then either commit a real second attempt
 * (`"retry"`) or fail the commit outright (`"fail"`). A transaction callback is
 * not a one-shot: it may run several times and only one attempt lands.
 */
const attemptDiscarded = (outcome: "retry" | "fail") => {
  const original = store.runTransaction.bind(store);
  return jest.spyOn(store, "runTransaction").mockImplementation(async fn => {
    await original(async txn => fn({ ...txn, set: () => {}, update: () => {}, delete: () => {} }));
    if (outcome === "fail") throw new Error("ABORTED: commit failed");
    return original(fn);
  });
};

it("charges a successfully settled reservation exactly once, however often settle runs", async () => {
  // Harm: a retried or duplicated settle bills the customer twice for one script.
  const charge = await repo.reserve({ actor, kind: "script", projectId: "project-a" });

  expect(await repo.settle(charge, false)).toBe(true);
  // The receipt permitted the charge and the first settle consumed it, so every
  // later settle has nothing to bill and says so.
  expect(await repo.settle(charge, false)).toBe(false);
  expect(await repo.settle(charge, false)).toBe(false);

  expect(balance().consumed).toBe(5);
  expect(usage()).toEqual({ credits: 5, scripts: 1 });
  expect(balance().pendingCharges).toEqual({});
  expect(balance().generationLocks).toEqual({});
});

it("counts a free generation once, however often settle runs", async () => {
  // Harm: per-channel usage over-reports what the channel actually generated, so
  // the numbers stop reconciling with the actions taken — and a free run has no
  // pending charge to protect it, only its usage receipt.
  process.env.MONTHLY_CREDIT_ALLOWANCE = "unlimited";
  const charge = await repo.reserve({ actor, kind: "ideas" });
  expect(charge?.debited).toBe(false);

  expect(await repo.settle(charge, false)).toBe(true);
  expect(await repo.settle(charge, false)).toBe(false);

  expect(usage()).toEqual({ credits: 3, ideas: 1 });
  expect(balance().consumed).toBe(0);
  expect(balance().usageReceipts).toEqual({});
  expect(balance().generationLocks).toEqual({});
});

it("two concurrent successful settlements of one reservation charge once", async () => {
  // Harm: a retry arriving while the first settle is still in flight bills the
  // same generation twice and counts it twice.
  const charge = await repo.reserve({ actor, kind: "description", projectId: "project-a" });
  const spy = serialised();

  const outcomes = await Promise.all([repo.settle(charge, false), repo.settle(charge, false)]);

  expect(outcomes.sort()).toEqual([false, true]);
  expect(balance().consumed).toBe(2);
  expect(usage()).toEqual({ credits: 2, packaging: 1 });
  spy.mockRestore();
});

it("a success across the monthly reset charges nothing to the new period and files usage in the old one", async () => {
  // Harm: a September generation whose settle lands after the 1st either bills
  // October's fresh allowance for credits the user never spent this month, or
  // disappears from September's usage so the channel's numbers stop reconciling.
  const september = await repo.reserve({ actor, kind: "ideas" });
  jest.setSystemTime(new Date("2026-10-01T00:00:00Z"));
  await repo.getBalance(actor); // the rollover: consumed zeroed, period advanced

  expect(await repo.settle(september, false)).toBe(true);

  expect(balance()).toMatchObject({ periodStart: "2026-10", consumed: 0 });
  expect(usage("2026-10")).toBeUndefined();
  // Usage counts what was DELIVERED, filed in the period the run belonged to —
  // the same notional-cost bookkeeping a metering-disabled month already gets,
  // where `usage.credits` records the price of the action and `consumed` does not move.
  expect(usage("2026-09")).toEqual({ credits: 3, ideas: 1 });
  // And the stale receipt is consumed, so no later retry can find October's allowance.
  expect(balance().pendingCharges).toEqual({});
  expect(await repo.settle(september, false)).toBe(false);
});

it("a success across the reset survives a NEW RESERVATION having swept the month", async () => {
  /**
   * The rollover test above advances the period with `getBalance()`, which leaves
   * pending receipts alone — so it passes whether or not this bug exists.
   *
   * `reserve()` is what prunes. It used to delete every receipt belonging to another
   * period, so an October reservation by the same payer swept a still-running
   * September reservation's receipt. The September success then hit the
   * receipt-required gate and returned false BEFORE any write: no usage recorded, and
   * the generation locks never released — blocking that kind until they aged out.
   *
   * Now pruning removes only ABANDONED receipts (dead lock), and the reserved total
   * counts only the current period, so an older live receipt survives to be settled
   * without consuming the new month's headroom.
   */
  // Seconds before the boundary, because the window is only as wide as the lock TTL:
  // a reservation whose lock has already expired is genuinely abandoned and SHOULD be
  // pruned. The bug is about a generation that is still running as the month turns.
  jest.setSystemTime(new Date("2026-09-30T23:59:30Z"));
  store.seed("billing", [{ id: "payer", allowance: 50, consumed: 0, periodStart: "2026-09" }]);
  const september = await repo.reserve({ actor, kind: "ideas" });

  jest.setSystemTime(new Date("2026-10-01T00:00:10Z")); // 40s later: lock still live
  // October's own reservation — this is the sweep.
  const october = await repo.reserve({ actor, kind: "hooks" });
  expect(balance().periodStart).toBe("2026-10");
  // September's receipt is still there, because its lock is still live.
  expect(balance().pendingCharges[september!.token]).toMatchObject({ periodStart: "2026-09" });

  expect(await repo.settle(september, false)).toBe(true);

  // Filed in the month it belonged to, and October is untouched by it.
  expect(usage("2026-09")).toEqual({ credits: 3, ideas: 1 });
  expect(balance().consumed).toBe(0);
  // And the lock is actually released, rather than stranded until expiry.
  expect(balance().generationLocks[september!.lockKey]).toBeUndefined();

  await repo.settle(october, false);
});

it("an older live reservation does not eat the new month's allowance", async () => {
  // The other half: September's receipt now SURVIVES the sweep, so it must not be
  // counted against October's fresh allowance or a new month would start pre-spent.
  jest.setSystemTime(new Date("2026-09-30T23:59:30Z"));
  store.seed("billing", [{ id: "payer", allowance: 5, consumed: 0, periodStart: "2026-09" }]);
  const september = await repo.reserve({ actor, kind: "script" }); // cost 5 — all of September

  jest.setSystemTime(new Date("2026-10-01T00:00:10Z")); // lock still live, receipt survives

  // A DIFFERENT kind, or the duplicate-generation lock refuses it for an unrelated
  // reason and this test would prove nothing about the allowance.
  //
  // What this guards: the naive version of the fix, which keeps older receipts alive
  // AND counts them in `reserved`. September holds 5 of a 5 allowance, so that variant
  // refuses this 3-credit reservation (0 + 5 + 3 > 5) and October starts pre-spent.
  await expect(repo.reserve({ actor, kind: "ideas" })).resolves.toBeTruthy();
  expect(balance().pendingCharges[september!.token]).toMatchObject({ periodStart: "2026-09" });
});

it("charges once when Firestore retries the transaction callback", async () => {
  // Harm: Firestore re-running a contended callback bills per ATTEMPT — or leaves
  // the reservation and both locks behind, so the next generation is refused 409.
  const retrying = attemptDiscarded("retry");
  const charge = await repo.reserve({ actor, kind: "hooks", projectId: "project-a", mode: "regenerate" });
  expect(await repo.settle(charge, false)).toBe(true);
  retrying.mockRestore();

  expect(balance().consumed).toBe(1);
  expect(usage()).toEqual({ credits: 1, hooks: 1 });
  expect(balance().pendingCharges).toEqual({});
  expect(balance().generationLocks).toEqual({});
  expect(project().generationLocks).toEqual({});
});

it("a settle whose commit fails moves nothing, and the retry then charges once", async () => {
  // Harm: a half-applied settlement either bills the customer while leaving the
  // lock held (next generation refused), or releases the lock and the receipt
  // without billing (the generation is free).
  const charge = await repo.reserve({ actor, kind: "title", projectId: "project-a" });
  const failing = attemptDiscarded("fail");

  await expect(repo.settle(charge, false)).rejects.toThrow(/ABORTED/);
  failing.mockRestore();

  expect(balance().consumed).toBe(0);
  expect(usage()).toBeUndefined();
  expect(balance().pendingCharges[charge!.token]).toEqual({ periodStart: "2026-09", cost: 1 });
  expect(balance().generationLocks[charge!.lockKey].token).toBe(charge!.token);

  expect(await repo.settle(charge, false)).toBe(true);
  expect(balance().consumed).toBe(1);
  expect(usage()).toEqual({ credits: 1, title: 1 });
});


it("repairs a legacy expired lock without losing saved hook choices", async () => {
  for (const saved of [false, true]) {
    const project = store.col("videoProjects").get("project-a")! as any;
    project.pipeline.hooks = { status: "in_progress", startedAt: 1, completedAt: null };
    project.generationLocks = { hooks: { token: "legacy", startedAt: Date.now() - 181_000 } };
    if (saved) {
      project.hooksId = "saved-hooks";
      store.seed("hooks", [{ id: "saved-hooks", hooks: ["Keep this choice"] }]);
    }
    const charge = await repo.reserve({ actor, kind: "hooks", projectId: "project-a", mode: saved ? "regenerate" : undefined });
    await repo.settle(charge, true);
    expect((store.col("videoProjects").get("project-a")! as any).pipeline.hooks.status).toBe(saved ? "in_progress" : "not_started");
  }
});
