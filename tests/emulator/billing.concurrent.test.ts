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
import StepRunner from "../../src/service/step-runner";

const local =
  process.env.FIRESTORE_EMULATOR_HOST === "127.0.0.1:18089"
    ? describe
    : describe.skip;
local("real Firestore billing contention acceptance", () => {
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

  it("allows exactly one of eight concurrent same-kind reservations", async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () => billing.reserve(spec)),
    );
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    for (const result of results)
      if (result.status === "rejected")
        expect(result.reason).toMatchObject({ statusCode: 409 });
    const winner = results.find((result) => result.status === "fulfilled");
    if (winner?.status !== "fulfilled") throw new Error("No winner");
    await billing.settle(winner.value, false);
    expect((await get("billing", "payer"))?.consumed).toBe(1);
    expect((await get("accounts/account-a/usage", period()))?.hooks).toBe(1);
  });

  it("cannot overspend the final shared credit across concurrent channels", async () => {
    process.env.MONTHLY_CREDIT_ALLOWANCE = "1";
    const results = await Promise.allSettled([
      billing.reserve(spec),
      billing.reserve({
        ...spec,
        actor: { ...actor, accountId: "account-b" },
        projectId: "project-b",
      }),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.find((result) => result.status === "rejected"),
    ).toMatchObject({
      reason: { statusCode: 402, code: "insufficient_credits" },
    });
    await Promise.all(
      results.map((result) =>
        result.status === "fulfilled"
          ? billing.settle(result.value, false)
          : Promise.resolve(),
      ),
    );
    expect((await get("billing", "payer"))?.consumed).toBe(1);
  });

  it("settles one successful paid receipt exactly once under contention", async () => {
    const charge = await billing.reserve(spec);
    const results = await Promise.all(
      Array.from({ length: 8 }, () => billing.settle(charge, false)),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    expect((await get("billing", "payer"))?.consumed).toBe(1);
    expect((await get("accounts/account-a/usage", period()))?.hooks).toBe(1);
  });

  it("unconfigured enforcement permits generation and counts free settlement exactly once", async () => {
    delete process.env.MONTHLY_CREDIT_ALLOWANCE;
    expect(await billing.getBalance(actor)).toMatchObject({
      enabled: false,
      remaining: null,
      allowance: null,
    });
    const charge = await billing.reserve(spec);
    await Promise.all(
      Array.from({ length: 8 }, () => billing.settle(charge, false)),
    );
    expect((await get("billing", "payer"))?.consumed).toBe(0);
    expect((await get("accounts/account-a/usage", period()))?.hooks).toBe(1);
  });

  it("configured zero refuses paid work but allows free prefill; malformed config refuses", async () => {
    process.env.MONTHLY_CREDIT_ALLOWANCE = "0";
    await expect(billing.reserve(spec)).rejects.toMatchObject({
      statusCode: 402,
    });
    const free = await billing.reserve({ actor, kind: "prefill" });
    await billing.settle(free, false);
    process.env.MONTHLY_CREDIT_ALLOWANCE = "invalid";
    await expect(billing.reserve(spec)).rejects.toMatchObject({
      statusCode: 503,
    });
  });

  it("expired owner cannot overwrite successor output or release its lock", async () => {
    const old = await billing.reserve(spec);
    if (!old) throw new Error("missing reservation");
    const expired = Timestamp.fromMillis(Date.now() - 181000);
    await db
      .collection("billing")
      .doc("payer")
      .update({ [`generationLocks.${old.lockKey}.startedAt`]: expired });
    await db
      .collection("videoProjects")
      .doc("project-a")
      .update({ "generationLocks.hooks.startedAt": expired });
    const next = await billing.reserve(spec);
    await db
      .collection("hooks")
      .doc("hooks-a")
      .set({ hooks: ["new output"] });
    await expect(
      new HooksRepository().update("hooks-a", { hooks: ["stale output"] }, old),
    ).rejects.toMatchObject({ statusCode: 409 });
    await billing.settle(old, true);
    expect(
      (await get("videoProjects", "project-a"))?.generationLocks.hooks.token,
    ).toBe(next?.token);
    expect((await get("hooks", "hooks-a"))?.hooks).toEqual(["new output"]);
    await billing.settle(next, false);
    expect((await get("billing", "payer"))?.consumed).toBe(1);
  });

  it("failed persistence neither consumes allowance nor records delivered usage", async () => {
    await expect(
      new StepRunner(billing).run(spec, async () => {
        throw new Error("storage failed");
      }),
    ).rejects.toMatchObject({ detail: { charged: false } });
    expect((await get("billing", "payer"))?.consumed).toBe(0);
    expect(await get("accounts/account-a/usage", period())).toBeUndefined();
    expect(
      (await get("videoProjects", "project-a"))?.pipeline.hooks.status,
    ).toBe("not_started");
  });

  it("refuses ownership transfer during an active reservation", async () => {
    await billing.reserve(spec);
    await expect(
      new SharingRepository().change(
        "account-a",
        "payer",
        "editor",
        "owner",
        true,
      ),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect((await get("accounts", "account-a"))?.billingOwnerUid).toBe("payer");
  });

  it("late prior-month completion cannot debit the current month", async () => {
    const charge = await billing.reserve(spec);
    if (!charge) throw new Error("missing reservation");
    await db
      .collection("billing")
      .doc("payer")
      .update({ periodStart: "2099-01", consumed: 3 });
    await billing.settle(charge, false);
    expect(await get("billing", "payer")).toMatchObject({
      periodStart: "2099-01",
      consumed: 3,
    });
    expect(
      (await get("accounts/account-a/usage", charge.periodStart))?.hooks,
    ).toBe(1);
  });

  it("single-use invitation acceptance survives actual competing transactions", async () => {
    const sharing = new SharingRepository();
    const { invite } = await sharing.create(
      "account-a",
      "payer",
      "guest@example.com",
      "viewer",
    );
    const results = await Promise.allSettled(
      Array.from({ length: 4 }, () =>
        sharing.accept(invite.token, "guest", "guest@example.com", true),
      ),
    );
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    for (const result of results)
      if (result.status === "rejected")
        expect(result.reason).toMatchObject({ code: "invite_used" });
    expect(
      (await get("accounts", "account-a"))?.memberUids.filter(
        (id: string) => id === "guest",
      ),
    ).toHaveLength(1);
    expect((await get("invites", invite.token))?.status).toBe("accepted");
  });

  it("concurrent owner self-demotions preserve an owner and the billing owner", async () => {
    await db
      .collection("accounts")
      .doc("account-a")
      .update({
        "members.editor.role": "owner",
        ownerUids: ["payer", "editor"],
      });
    const sharing = new SharingRepository();
    const results = await Promise.allSettled([
      sharing.change("account-a", "payer", "payer", "editor"),
      sharing.change("account-a", "editor", "editor", "editor"),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.find((result) => result.status === "rejected"),
    ).toMatchObject({ reason: { statusCode: 400 } });
    const account = await get("accounts", "account-a");
    expect(account?.ownerUids).toHaveLength(1);
    expect(account?.ownerUids).toContain(account?.billingOwnerUid);
  });

  it("simultaneous stale failure and successor success leave one charge and one delivered item", async () => {
    const first = await billing.reserve(spec);
    if (!first) throw new Error("missing reservation");
    const expired = Timestamp.fromMillis(Date.now() - 181000);
    await db
      .collection("billing")
      .doc("payer")
      .update({ [`generationLocks.${first.lockKey}.startedAt`]: expired });
    await db
      .collection("videoProjects")
      .doc("project-a")
      .update({ "generationLocks.hooks.startedAt": expired });
    const next = await billing.reserve(spec);
    await Promise.all([
      billing.settle(first, true),
      billing.settle(next, false),
    ]);
    expect((await get("billing", "payer"))?.consumed).toBe(1);
    expect((await get("billing", "payer"))?.generationLocks).toEqual({});
    expect((await get("videoProjects", "project-a"))?.generationLocks).toEqual(
      {},
    );
    expect((await get("accounts/account-a/usage", period()))?.hooks).toBe(1);
  });

  it("lazy monthly reset commits before simultaneous new-period reservation decisions", async () => {
    process.env.MONTHLY_CREDIT_ALLOWANCE = "1";
    await db.collection("billing").doc("payer").set({
      periodStart: "2000-01",
      consumed: 99,
      allowanceSource: "default",
    });
    const results = await Promise.allSettled([
      billing.getBalance(actor),
      billing.reserve(spec),
      billing.reserve({
        ...spec,
        actor: { ...actor, accountId: "account-b" },
        projectId: "project-b",
      }),
    ]);
    expect(
      results.slice(1).filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(await get("billing", "payer")).toMatchObject({
      periodStart: period(),
      consumed: 0,
    });
  });

  it("preserves numeric consumption when a supported numeric-string balance is written during a reservation", async () => {
    const charge = await billing.reserve(spec);
    await db.collection("billing").doc("payer").update({ consumed: "2" });
    expect(await billing.getBalance(actor)).toMatchObject({ consumed: 2 });
    await billing.settle(charge, false);
    expect((await get("billing", "payer"))?.consumed).toBe(3);
  });

  it("stale-email invite acceptance racing demotion cannot restore removed editor access", async () => {
    const sharing = new SharingRepository();
    await db
      .collection("users")
      .doc("editor")
      .set({ email: "old@example.com" });
    const { invite } = await sharing.create(
      "account-a",
      "payer",
      "new@example.com",
      "editor",
    );
    const results = await Promise.allSettled([
      sharing.accept(invite.token, "editor", "new@example.com", true),
      sharing.change("account-a", "payer", "editor", "viewer"),
    ]);
    expect(results[1].status).toBe("fulfilled");
    if (results[0].status === "rejected")
      expect(results[0].reason).toMatchObject({ code: "invite_revoked" });
    expect((await get("accounts", "account-a"))?.members.editor.role).toBe(
      "viewer",
    );
    const { invite: fresh } = await sharing.create(
      "account-a",
      "payer",
      "new@example.com",
      "editor",
    );
    await sharing.accept(fresh.token, "editor", "new@example.com", true);
    expect((await get("accounts", "account-a"))?.members.editor.role).toBe(
      "editor",
    );
  });
  it("malformed consumption discovered at settlement fails without consuming the receipt", async () => {
    const charge = await billing.reserve(spec);
    if (!charge) throw new Error("missing reservation");
    await db
      .collection("billing")
      .doc("payer")
      .update({ consumed: { invalid: true } });
    await expect(billing.settle(charge, false)).rejects.toMatchObject({
      statusCode: 503,
    });
    expect(
      (await get("billing", "payer"))?.pendingCharges[charge.token],
    ).toBeDefined();
    expect(await get("accounts/account-a/usage", period())).toBeUndefined();
  });
  it("enabling allowance during a free run charges only subsequently reserved paid work", async () => {
    delete process.env.MONTHLY_CREDIT_ALLOWANCE;
    const free = await billing.reserve(spec);
    process.env.MONTHLY_CREDIT_ALLOWANCE = "1";
    const paid = await billing.reserve({
      ...spec,
      actor: { ...actor, accountId: "account-b" },
      projectId: "project-b",
    });
    await Promise.all([
      billing.settle(free, false),
      billing.settle(paid, false),
    ]);
    expect((await get("billing", "payer"))?.consumed).toBe(1);
    expect((await get("accounts/account-a/usage", period()))?.hooks).toBe(1);
    expect((await get("accounts/account-b/usage", period()))?.hooks).toBe(1);
  });
});
