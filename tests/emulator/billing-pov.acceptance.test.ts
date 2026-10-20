/** Opt-in local real-Firestore transaction checks.
 * FIRESTORE_EMULATOR_HOST=127.0.0.1:18089 npm test -- --runInBand tests/emulator/billing.concurrent.test.ts
 * Uses only demo-momentum-review; production Firebase bootstrap is replaced before import.
 */
jest.mock("../../src/config/firebase", () => {
  if (
    process.env.FIRESTORE_EMULATOR_HOST &&
    process.env.FIRESTORE_EMULATOR_HOST !== "127.0.0.1:18089"
  )
    throw new Error("Review requires its dedicated loopback emulator");
  const { Firestore, FieldValue } =
    require("firebase-admin/firestore") as typeof import("firebase-admin/firestore");
  const db = new Firestore({
    projectId: "demo-momentum-review",
    host: "127.0.0.1:18089",
    ssl: false,
    ignoreUndefinedProperties: true,
  });
  return { db, firebase: { firestore: { FieldValue } } };
});
import { db } from "../../src/config/firebase";
import { Timestamp } from "firebase-admin/firestore";
import BillingRepository from "../../src/repository/billing.repository";
import HooksRepository from "../../src/repository/hooks.repository";
import SharingRepository from "../../src/repository/sharing.repository";
import VideoProjectService from "../../src/service/video-project.service";
import VideoProjectRepository from "../../src/repository/video-project.repository";
import ContentRepository from "../../src/repository/content.repository";
import PackagingRepository from "../../src/repository/packaging.repository";
import AccountRepository from "../../src/repository/account.repository";

const local =
  process.env.FIRESTORE_EMULATOR_HOST === "127.0.0.1:18089"
    ? describe
    : describe.skip;
local("independent billing point-of-view acceptance", () => {
  jest.setTimeout(60000);
  const billing = new BillingRepository();
  const actor = { userId: "editor", accountId: "account-a" };
  const spec = { actor, kind: "hooks" as const, projectId: "project-a" };
  const period = () => new Date().toISOString().slice(0, 7);
  const get = async (collection: string, id: string) =>
    (await db.collection(collection).doc(id).get()).data();
  const originalAllowance = process.env.MONTHLY_CREDIT_ALLOWANCE;
  beforeEach(async () => {
    const response = await fetch(
      "http://127.0.0.1:18089/emulator/v1/projects/demo-momentum-review/databases/(default)/documents",
      { method: "DELETE" },
    );
    if (!response.ok)
      throw new Error(`Could not reset isolated emulator: ${response.status}`);
    process.env.MONTHLY_CREDIT_ALLOWANCE = "20";
    for (const suffix of ["a", "b"]) {
      await db
        .collection("accounts")
        .doc(`account-${suffix}`)
        .set({
          billingOwnerUid: "payer",
          members: { payer: { role: "owner" }, editor: { role: "editor" } },
          memberUids: ["payer", "editor"],
          ownerUids: ["payer"],
        });
      await db
        .collection("videoProjects")
        .doc(`project-${suffix}`)
        .set({
          accountId: `account-${suffix}`,
          currentStep: "script",
          pipeline: {
            research: { status: "completed" },
            title: { status: "not_started" },
            packaging: { status: "not_started" },
            script: { status: "completed" },
            hooks: { status: "not_started" },
          },
        });
    }
  });
  afterAll(async () => {
    if (originalAllowance === undefined)
      delete process.env.MONTHLY_CREDIT_ALLOWANCE;
    else process.env.MONTHLY_CREDIT_ALLOWANCE = originalAllowance;
    await db.terminate();
  });

  it("free prefill remains available after lowering allowance below spent credits", async () => {
    await billing.settle(await billing.reserve(spec), false);
    process.env.MONTHLY_CREDIT_ALLOWANCE = "0";
    expect(await billing.getBalance(actor)).toMatchObject({ allowance: 0, consumed: 1 });
    const free = await billing.reserve({ actor, kind: "prefill" });
    await billing.settle(free, false);
    expect((await get("billing", "payer"))?.consumed).toBe(1);
  });

  it.each(["not_started", "stale"])("failed successor restores stable %s state and permits another retry", async originalStatus => {
    await db.collection("videoProjects").doc("project-a").update({ "pipeline.hooks.status": originalStatus });
    const first = await billing.reserve(spec);
    const expired = Timestamp.fromMillis(Date.now() - 181_000);
    await db.collection("billing").doc("payer").update({ [`generationLocks.${first!.lockKey}.startedAt`]: expired });
    await db.collection("videoProjects").doc("project-a").update({ "generationLocks.hooks.startedAt": expired });
    const second = await billing.reserve(spec);
    await billing.settle(first, true);
    await billing.settle(second, true);
    expect((await get("billing", "payer"))?.consumed).toBe(0);
    expect((await get("videoProjects", "project-a"))?.generationLocks).toEqual({});
    const projectService = new VideoProjectService(new VideoProjectRepository(), new ContentRepository(), new PackagingRepository(), new HooksRepository(), new AccountRepository());
    const returned = await projectService.getReconciledById("project-a", actor);
    expect(returned.hooksId).toBeUndefined();
    // Verify this is status corruption, not a hard retry lockout.
    const retry = await billing.reserve(spec);
    expect(retry).toBeTruthy();
    await billing.settle(retry, true);
    expect(returned.pipeline.hooks.status).toBe(originalStatus);
  });

  it("payer-wide expiry sweep prevents unrelated stale content persistence", async () => {
    const old = await billing.reserve(spec);
    const expired = Timestamp.fromMillis(Date.now() - 181_000);
    await db.collection("billing").doc("payer").update({ [`generationLocks.${old!.lockKey}.startedAt`]: expired });
    await db.collection("videoProjects").doc("project-a").update({ "generationLocks.hooks.startedAt": expired });
    const other = await billing.reserve({ actor: { ...actor, accountId: "account-b" }, kind: "ideas" });
    await db.collection("hooks").doc("stale-result").set({ hooks: ["existing"] });
    await expect(new HooksRepository().update("stale-result", { hooks: ["late"] }, old)).rejects.toMatchObject({ statusCode: 409 });
    await billing.settle(other, false);
    expect((await get("hooks", "stale-result"))?.hooks).toEqual(["existing"]);
    expect((await get("billing", "payer"))?.consumed).toBe(3);
  });

  it("expired payer transfer followed by a new run fences the old output and charges the new payer", async () => {
    const old = await billing.reserve(spec);
    const expired = Timestamp.fromMillis(Date.now() - 181_000);
    await db.collection("billing").doc("payer").update({ [`generationLocks.${old!.lockKey}.startedAt`]: expired });
    await db.collection("videoProjects").doc("project-a").update({ "generationLocks.hooks.startedAt": expired });
    await new SharingRepository().change("account-a", "payer", "editor", "owner", true);
    const next = await billing.reserve(spec);
    await db.collection("hooks").doc("result").set({ hooks: ["existing"] });
    await new HooksRepository().update("result", { hooks: ["new payer result"] }, next);
    await expect(new HooksRepository().update("result", { hooks: ["old payer result"] }, old)).rejects.toMatchObject({ statusCode: 409 });
    await billing.settle(old, true);
    expect((await get("videoProjects", "project-a"))?.generationLocks.hooks.token).toBe(next?.token);
    await billing.settle(next, false);
    expect((await get("hooks", "result"))?.hooks).toEqual(["new payer result"]);
    expect((await get("videoProjects", "project-a"))?.generationLocks).toEqual({});
    expect((await get("billing", "payer"))?.consumed).toBe(0);
    expect((await get("billing", "editor"))?.consumed).toBe(1);
  });

  it("numeric stored consumption is normalized and retains spend across disabled mode", async () => {
    await db.collection("billing").doc("payer").set({ allowanceSource: "default", periodStart: period(), consumed: "4" });
    delete process.env.MONTHLY_CREDIT_ALLOWANCE;
    await billing.settle(await billing.reserve(spec), false);
    expect((await get("billing", "payer"))?.consumed).toBe(4);
    process.env.MONTHLY_CREDIT_ALLOWANCE = "4";
    await expect(billing.reserve(spec)).rejects.toMatchObject({ statusCode: 402 });
  });

  it("more than256 paid live receipts remain enforceable and expired ones recover capacity", async () => {
    process.env.MONTHLY_CREDIT_ALLOWANCE = "260";
    const locks = Object.fromEntries(Array.from({length: 260}, (_,i) => [`lock${i}`, {token:`receipt${i}`,startedAt:Timestamp.now()}]));
    const pending = Object.fromEntries(Array.from({length: 260}, (_,i) => [`receipt${i}`, {periodStart:period(),cost:1}]));
    await db.collection("billing").doc("payer").set({ allowanceSource: "default", periodStart: period(), consumed: 0, generationLocks:locks, pendingCharges:pending });
    await expect(billing.reserve(spec)).rejects.toMatchObject({ statusCode:402 });
    await db.collection("billing").doc("payer").update({ generationLocks:{} });
    await billing.settle(await billing.reserve(spec), false);
    expect((await get("billing", "payer"))?.consumed).toBe(1);
    expect((await get("billing", "payer"))?.pendingCharges).toEqual({});
  });

  it("concurrent terminal success retries charge only once", async () => {
    const charge = await billing.reserve(spec);
    const settled = await Promise.all(Array.from({length:5}, () => billing.settle(charge,false)));
    expect(settled.filter(Boolean)).toHaveLength(1);
    expect((await get("billing", "payer"))?.consumed).toBe(1);
  });

  it("a removed actor cannot persist an already generated result", async () => {
    const charge = await billing.reserve(spec);
    await db.collection("accounts").doc("account-a").update({members:{payer:{role:"owner"}}});
    await db.collection("hooks").doc("result").set({hooks:["existing"]});
    await expect(new HooksRepository().update("result",{hooks:["generated"]},charge)).rejects.toMatchObject({statusCode:403});
    await billing.settle(charge,true);
    expect((await get("billing", "payer"))?.consumed).toBe(0);
  });

  it.each([false, {}, "0x10", -1])("invalid configured override %p fails before creating a lock", async value => {
    await db.collection("billing").doc("payer").set({ allowanceOverride:value });
    await expect(billing.reserve(spec)).rejects.toMatchObject({statusCode:503});
    expect((await get("videoProjects","project-a"))?.generationLocks).toBeUndefined();
  });
  it("a live prior-month hold survives a new-month reserve and records its original usage only", async () => {
    const old = await billing.reserve(spec);
    if (!old) throw new Error("reservation missing");
    old.periodStart = "2000-01";
    await db.collection("billing").doc("payer").update({periodStart:"2000-01", consumed:7, [`pendingCharges.${old.token}.periodStart`]:"2000-01"});
    const current = await billing.reserve({actor:{...actor,accountId:"account-b"},kind:"ideas"});
    expect((await get("billing","payer"))?.pendingCharges[old.token]).toBeDefined();
    await billing.settle(old,false);
    expect((await get("billing","payer"))?.consumed).toBe(0);
    expect((await get("accounts/account-a/usage","2000-01"))?.hooks).toBe(1);
    await billing.settle(current,false);
    expect((await get("billing","payer"))?.consumed).toBe(3);
  });
  it.each([
    ["empty", "not_started"],
    ["stale", "stale"],
    ["saved", "in_progress"],
  ])("legacy expired lock without prior restores %s output state", async (state, expected) => {
    const old = await billing.reserve(spec);
    if (!old) throw new Error("reservation missing");
    const expired = Timestamp.fromMillis(Date.now() - 181_000);
    await db.collection("billing").doc("payer").update({ [`generationLocks.${old.lockKey}.startedAt`]: expired });
    await db.collection("videoProjects").doc("project-a").update({
      "generationLocks.hooks": { token: old.token, startedAt: expired },
      ...(state === "stale" ? { "pipeline.hooks.staleReason": "script_regenerated" } : {}),
      ...(state === "saved" ? { hooksId: "saved-hooks" } : {}),
    });
    if (state === "saved") await db.collection("hooks").doc("saved-hooks").set({ hooks: ["saved option"], accountId: actor.accountId });
    // Normal creation rejects replay of persisted hooks; exercise that contract
    // instead of manufacturing a create takeover past the replay guard.
    if (state === "saved") {
      await expect(billing.reserve(spec)).rejects.toMatchObject({statusCode:409});
      expect((await get("videoProjects", "project-a"))?.pipeline.hooks.status).toBe(expected);
      expect((await get("hooks", "saved-hooks"))?.hooks).toEqual(["saved option"]);
      return;
    }
    const replacement = await billing.reserve(spec);
    await billing.settle(replacement, true);
    const projectService = new VideoProjectService(new VideoProjectRepository(), new ContentRepository(), new PackagingRepository(), new HooksRepository(), new AccountRepository());
    expect((await projectService.getReconciledById("project-a", actor)).pipeline.hooks.status).toBe(expected);
    expect((await get("videoProjects", "project-a"))?.generationLocks).toEqual({});
  });

});
