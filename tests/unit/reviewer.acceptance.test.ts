jest.mock("../../src/config/firebase", () =>
  require("../helpers/fake-firestore").mockFirebase(),
);
jest.mock("../../src/utlils/ai", () => ({
  generateStreamingContent: jest.fn(),
  generateTextContent: jest.fn(),
  collectJson: jest.fn(async (value) => value),
}));
import { generateStreamingContent, generateTextContent } from "../../src/utlils/ai";
import ContentService from "../../src/service/content.service";
import PackagingService from "../../src/service/packaging.service";
import HooksService from "../../src/service/hooks.service";
import HooksRepository from "../../src/repository/hooks.repository";
import VideoProjectRepository from "../../src/repository/video-project.repository";
import VideoProjectService from "../../src/service/video-project.service";
import ContentRepository from "../../src/repository/content.repository";
import PackagingRepository from "../../src/repository/packaging.repository";
import AccountRepository from "../../src/repository/account.repository";
import BillingRepository from "../../src/repository/billing.repository";
import StepRunner from "../../src/service/step-runner";
import SharingRepository from "../../src/repository/sharing.repository";
import { FakeFirestore, FakeTxn } from "../helpers/fake-firestore";
import { Timestamp } from "firebase-admin/firestore";

const store: FakeFirestore = require("../../src/config/firebase").__db;
const billing = new BillingRepository();
const sharing = new SharingRepository();
const actor = { userId: "editor", accountId: "account-a" };
const spec = { actor, kind: "hooks" as const, projectId: "project-a" };
const row = (collection: string, id: string) =>
  store.col(collection).get(id) as any;
const clone = (value: any): any =>
  Array.isArray(value)
    ? value.map(clone)
    : value && typeof value === "object"
      ? Object.assign(
          Object.create(Object.getPrototypeOf(value)),
          Object.fromEntries(
            Object.entries(value).map(([key, item]) => [key, clone(item)]),
          ),
        )
      : value;
let transaction: jest.SpyInstance;
beforeEach(() => {
  jest.useFakeTimers().setSystemTime(new Date("2026-09-26T00:00:00Z"));
  process.env.MONTHLY_CREDIT_ALLOWANCE = "20";
  store.data.clear();
  store.seed("accounts", [
    {
      id: "account-a",
      displayName: "Cooking",
      billingOwnerUid: "owner",
      memberUids: ["owner", "editor"],
      ownerUids: ["owner"],
      members: { owner: { role: "owner" }, editor: { role: "editor" } },
    },
  ]);
  store.seed("videoProjects", [
    {
      id: "project-a",
      accountId: "account-a",
      currentStep: "script",
      pipeline: {
        script: { status: "completed" },
        hooks: { status: "not_started" },
      },
    },
  ]);
  const original = store.runTransaction.bind(store);
  let queue: Promise<unknown> = Promise.resolve();
  // A serial schedule is one legal Firestore execution, not a contention emulator.
  // Clone reads so mutating a nested snapshot cannot mutate persisted fixtures.
  transaction = jest.spyOn(store, "runTransaction").mockImplementation((fn) => {
    const next = queue.then(() =>
      original(async (txn) => {
        let writes = false;
        return fn({
          ...txn,
          get: async (ref) => {
            if (writes) throw new Error("Firestore rejects reads after writes");
            const snapshot = (await txn.get(ref)) as any;
            return { ...snapshot, data: () => clone(snapshot.data()) };
          },
          set: (...args: Parameters<FakeTxn["set"]>) => {
            writes = true;
            txn.set(...args);
          },
          update: (...args: Parameters<FakeTxn["update"]>) => {
            writes = true;
            txn.update(...args);
          },
          delete: (...args: Parameters<FakeTxn["delete"]>) => {
            writes = true;
            txn.delete(...args);
          },
        });
      }),
    );
    queue = next.catch(() => undefined);
    return next;
  });
});
afterEach(() => {
  transaction.mockRestore();
  jest.useRealTimers();
  process.env.MONTHLY_CREDIT_ALLOWANCE = "unlimited";
});

describe("independent metering acceptance", () => {
  it.each([false, true, [], {}, -1, 1.5, "bad"])(
    "fails closed on a malformed stored allowance override %p",
    async (value) => {
      store.seed("billing", [
        {
          id: "owner",
          allowanceOverride: value,
          allowanceSource: "default",
          consumed: 0,
          periodStart: "2026-09",
        },
      ]);
      await expect(billing.reserve(spec)).rejects.toMatchObject({
        statusCode: 503,
      });
      expect(row("videoProjects", "project-a").pipeline.hooks.status).toBe(
        "not_started",
      );
    },
  );
  it("atomically refuses unmet preconditions without any usage, lock, or debit", async () => {
    row("videoProjects", "project-a").pipeline.script.status = "stale";
    await expect(billing.reserve(spec)).rejects.toMatchObject({
      statusCode: 400,
    });
    expect(row("billing", "owner")).toBeUndefined();
    expect(row("accounts/account-a/usage", "2026-09")).toBeUndefined();
    expect(row("videoProjects", "project-a").generationLocks).toBeUndefined();
  });
  it("competing independent requests cannot both spend the final credit in a serializable schedule", async () => {
    process.env.MONTHLY_CREDIT_ALLOWANCE = "1";
    const results = await Promise.allSettled([
      billing.reserve(spec),
      billing.reserve({ ...spec, kind: "thumbnail" }),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toEqual([
      expect.objectContaining({
        reason: expect.objectContaining({
          statusCode: 402,
          code: "insufficient_credits",
        }),
      }),
    ]);
    // The reservation is what refuses the loser; the charge lands only on settle.
    expect(row("billing", "owner").consumed).toBe(0);
    const winner = results.find((result) => result.status === "fulfilled");
    await billing.settle(
      (winner as PromiseFulfilledResult<Awaited<ReturnType<typeof billing.reserve>>>).value,
      false,
    );
    expect(row("billing", "owner").consumed).toBe(1);
  });
  it("disabled mode stays free when enabled later; configured zero rejects new generations", async () => {
    process.env.MONTHLY_CREDIT_ALLOWANCE = "unlimited";
    const free = await billing.reserve(spec);
    expect(free?.debited).toBe(false);
    process.env.MONTHLY_CREDIT_ALLOWANCE = "0";
    await billing.settle(free, false);
    await expect(
      billing.reserve({ ...spec, kind: "thumbnail" }),
    ).rejects.toMatchObject({ code: "insufficient_credits" });
    expect(row("billing", "owner").consumed).toBe(0);
  });
  it("late failure after takeover releases only its receipt and preserves successor locks and status", async () => {
    const first = await billing.reserve(spec);
    jest.advanceTimersByTime(181000);
    const successor = await billing.reserve(spec);
    await billing.settle(first, true);
    // Neither run is charged yet: only the successor's own settle can bill, and
    // the superseded run releases without touching the money or the successor.
    expect(row("billing", "owner").consumed).toBe(0);
    expect(row("videoProjects", "project-a").generationLocks.hooks.token).toBe(
      successor?.token,
    );
    expect(row("videoProjects", "project-a").pipeline.hooks.status).toBe(
      "in_progress",
    );
    expect(await billing.settle(first, true)).toBe(false);
    await billing.settle(successor, false);
    expect(row("billing", "owner").consumed).toBe(1);
  });
  it("blocks payer transfer while active, and bills only the new payer afterwards", async () => {
    const first = await billing.reserve(spec);
    await expect(
      sharing.change("account-a", "owner", "editor", "owner", true),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(row("accounts", "account-a").billingOwnerUid).toBe("owner");
    jest.advanceTimersByTime(181000);
    await sharing.change("account-a", "owner", "editor", "owner", true);
    const successor = await billing.reserve(spec);
    await billing.settle(first, true);
    // The original payer is never charged for the abandoned run, and the new
    // payer is charged only once their successor actually delivers.
    expect(row("billing", "owner").consumed).toBe(0);
    expect(row("billing", "editor").consumed).toBe(0);
    expect(row("videoProjects", "project-a").generationLocks.hooks.token).toBe(
      successor?.token,
    );
    await billing.settle(successor, false);
    expect(row("billing", "owner").consumed).toBe(0);
    expect(row("billing", "editor").consumed).toBe(1);
  });
  it("late prior-month failure never erases the new month's consumption", async () => {
    const first = await billing.reserve(spec);
    jest.setSystemTime(new Date("2026-10-01T00:00:00Z"));
    const october = await billing.reserve({ ...spec, kind: "thumbnail" });
    await billing.settle(first, true);
    expect(row("billing", "owner")).toMatchObject({
      consumed: 0,
      periodStart: "2026-10",
    });
    await billing.settle(october, false);
    // October's own run bills October; September's failure bills nothing, and in
    // particular cannot subtract from the fresh period.
    expect(row("billing", "owner")).toMatchObject({
      consumed: 1,
      periodStart: "2026-10",
    });
  });
  it("returns wrong_account for an accessible foreign project before billing", async () => {
    store.seed("accounts", [
      {
        id: "account-b",
        displayName: "Travel",
        billingOwnerUid: "other",
        members: { editor: { role: "viewer" } },
      },
    ]);
    row("videoProjects", "project-a").accountId = "account-b";
    await expect(billing.reserve(spec)).rejects.toMatchObject({
      statusCode: 403,
      code: "wrong_account",
      detail: { accountId: "account-b", displayName: "Travel" },
    });
    expect(row("billing", "owner")).toBeUndefined();
  });
  it("proves no charge only after the release transaction succeeds", async () => {
    await expect(
      new StepRunner(billing).run(spec, async () => {
        throw new Error("Persistence failed");
      }),
    ).rejects.toMatchObject({ statusCode: 503, detail: { charged: false } });
    expect(row("billing", "owner").consumed).toBe(0);
    expect(row("videoProjects", "project-a").pipeline.hooks.status).toBe(
      "not_started",
    );
  });
});

describe("independent invite terminal acceptance", () => {
  it.each(["deletedAt", "orphanedAt"])(
    "does not offer or consume an invite to a %s channel",
    async (field) => {
      const token = "A".repeat(43);
      store.seed("invites", [
        {
          id: token,
          accountId: "account-a",
          accountName: "Cooking",
          invitedByName: "Owner",
          email: "reader@example.com",
          role: "viewer",
          status: "pending",
          expiresAt: Timestamp.fromMillis(Date.now() + 60000),
        },
      ]);
      row("accounts", "account-a")[field] = Timestamp.now();
      await expect(sharing.preview(token)).rejects.toMatchObject({ statusCode: 404 });
      await expect(
        sharing.pending("reader@example.com", true),
      ).resolves.toEqual([]);
      await expect(
        sharing.accept(token, "reader", "reader@example.com", true),
      ).rejects.toMatchObject({ code: "invite_revoked" });
      expect(row("invites", token).status).toBe("pending");
      expect(row("accounts", "account-a").members.reader).toBeUndefined();
    },
  );
});

// "0" was removed from this list deliberately. A numeric string is what a JSON or
// CSV import writes, `allowance` has always accepted one, and refusing it here
// 503'd the payer — including on `GET /v1/billing`, so nothing could read or
// repair the document. Accepted now; the genuinely malformed values below still
// fail closed.
it.each([-10, null, false, 1.5, NaN, "lots", {}])(
  "fails closed on malformed current-month consumed value %p",
  async (consumed) => {
    store.seed("billing", [
      { id: "owner", allowance: 1, consumed, periodStart: "2026-09" },
    ]);
    await expect(billing.reserve(spec)).rejects.toMatchObject({
      statusCode: 503,
    });
    expect(row("videoProjects", "project-a").pipeline.hooks.status).toBe(
      "not_started",
    );
  },
);

it("accepts a numeric-string consumed rather than locking the payer out", async () => {
  store.seed("billing", [
    { id: "owner", allowance: 10, allowanceSource: "default", consumed: "4", periodStart: "2026-09" },
  ]);

  const charge = await billing.reserve(spec);

  expect(charge?.debited).toBe(true);
  await billing.settle(charge, false);
  expect(row("billing", "owner").consumed).toBe(5);
});

it("a stale successful hooks model cannot overwrite its successor's persisted output or status", async () => {
  const project = row("videoProjects", "project-a");
  project.pipeline = Object.fromEntries(
    ["research", "script", "hooks", "title", "packaging"].map((step) => [
      step,
      { status: "completed", startedAt: null, completedAt: 1 },
    ]),
  );
  project.hooksId = "hooks-a";
  project.selectedHookIndex = 0;
  project.currentStep = "packaging";
  store.seed("hooks", [
    {
      id: "hooks-a",
      videoProjectId: "project-a",
      accountId: "account-a",
      createdBy: "editor",
      hooks: ["original"],
      hookFeedback: {},
    },
  ]);
  const hooks = new HooksRepository();
  const accounts = new AccountRepository();
  const projects = new VideoProjectService(
    new VideoProjectRepository(),
    new ContentRepository(),
    new PackagingRepository(),
    hooks,
    accounts,
  );
  const service = new HooksService(
    hooks,
    projects,
    undefined,
    new StepRunner(billing),
    accounts,
  );
  let finishFirst!: (value: unknown) => void;
  let finishSecond!: (value: unknown) => void;
  jest
    .mocked(generateStreamingContent)
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishFirst = resolve;
        }) as any,
    )
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishSecond = resolve;
        }) as any,
    );
  const first = service.regenerate(actor, "hooks-a", "script");
  const firstOutcome = first.then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
  for (let i = 0; i < 50 && !finishFirst; i++) await Promise.resolve();
  expect(finishFirst).toBeDefined();
  jest.advanceTimersByTime(181000);
  const second = service.regenerate(actor, "hooks-a", "script");
  for (let i = 0; i < 50 && !finishSecond; i++) await Promise.resolve();
  expect(finishSecond).toBeDefined();
  finishSecond({ hooks: ["new successful hooks"] });
  await second;
  const snapshot = clone(row("videoProjects", "project-a"));
  finishFirst({ hooks: ["stale successful hooks"] });
  await expect(firstOutcome).resolves.toMatchObject({
    error: { statusCode: 409 },
  });
  expect(row("hooks", "hooks-a").hooks).toEqual(["new successful hooks"]);
  expect(row("videoProjects", "project-a")).toEqual(snapshot);
  expect(row("billing", "owner").consumed).toBe(1);
});

it("charges packaging independently at 2/1/1 and charges nothing for the failed description", async () => {
  const description = await billing.reserve({ ...spec, kind: "description" });
  const thumbnail = await billing.reserve({ ...spec, kind: "thumbnail" });
  const shorts = await billing.reserve({ ...spec, kind: "shorts" });
  // All three are reserved (2+1+1) and none charged yet, so the balance is
  // protected against a fourth concurrent item without any of them being billed.
  expect(row("billing", "owner").consumed).toBe(0);
  expect(Object.keys(row("billing", "owner").pendingCharges)).toHaveLength(3);
  await billing.settle(description, true);
  await billing.settle(thumbnail, false);
  await billing.settle(shorts, false);
  expect(row("billing", "owner").consumed).toBe(2);
  expect(row("accounts/account-a/usage", "2026-09")).toMatchObject({
    credits: 2,
    packaging: 2,
  });
});

it.each(["viewer", "removed", "orphaned"])(
  "never starts AI, locks, or debits for a %s actor",
  async (state) => {
    const account = row("accounts", "account-a");
    if (state === "viewer") account.members.editor.role = "viewer";
    else if (state === "removed") delete account.members.editor;
    else account.orphanedAt = Timestamp.now();
    const model = jest.fn(async () => "should not run");
    await expect(
      new StepRunner(billing).run(spec, model),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(model).not.toHaveBeenCalled();
    expect(row("billing", "owner")).toBeUndefined();
    expect(row("videoProjects", "project-a").generationLocks).toBeUndefined();
  },
);

it("reads and exports saved hooks with an explicitly exhausted zero allowance without creating billing", async () => {
  process.env.MONTHLY_CREDIT_ALLOWANCE = "0";
  store.seed("hooks", [
    {
      id: "hooks-a",
      videoProjectId: "project-a",
      accountId: "account-a",
      hooks: ["Copyable saved hook"],
    },
  ]);
  const service = new HooksService(
    new HooksRepository(),
    undefined as any,
    undefined,
    new StepRunner(billing),
    new AccountRepository(),
  );
  await expect(service.getById(actor, "hooks-a")).resolves.toMatchObject({
    hooks: ["Copyable saved hook"],
  });
  await expect(service.exportHooks(actor, "hooks-a")).resolves.toMatchObject({
    count: 1,
    text: expect.stringContaining("Copyable saved hook"),
  });
  expect(row("billing", "owner")).toBeUndefined();
});

it("counts only the successful generation after a disabled-metering takeover and late failure", async () => {
  process.env.MONTHLY_CREDIT_ALLOWANCE = "unlimited";
  const first = await billing.reserve(spec);
  jest.advanceTimersByTime(181000);
  const second = await billing.reserve(spec);
  await billing.settle(second, false);
  await billing.settle(first, true);
  expect(row("accounts/account-a/usage", "2026-09")).toMatchObject({
    credits: 1,
    hooks: 1,
  });
  // Releasing the superseded run stays safe on every retry: it moves no money,
  // and the successor's usage above is untouched.
  expect(await billing.settle(first, true)).toBe(true);
  expect(row("accounts/account-a/usage", "2026-09")).toMatchObject({ credits: 1, hooks: 1 });
});

it.each(["title", "description", "thumbnail", "shorts", "script"] as const)(
  "late successful %s generation cannot replace its successor's persisted output",
  async (kind) => {
    const project = row("videoProjects", "project-a");
    project.pipeline = Object.fromEntries(
      ["research", "script", "hooks", "title", "packaging"].map((step) => [
        step,
        { status: "completed", startedAt: null, completedAt: 1 },
      ]),
    );
    project.currentStep = "packaging";
    project.scriptId = "script-a";
    store.seed("scripts", [
      {
        id: "script-a",
        accountId: "account-a",
        videoProjectId: "project-a",
        title: "Video",
        script: "saved script",
      },
    ]);
    const content = new ContentRepository();
    const packaging = new PackagingRepository();
    const accounts = new AccountRepository();
    const projects = new VideoProjectService(
      new VideoProjectRepository(),
      content,
      packaging,
      new HooksRepository(),
      accounts,
    );
    const runner = new StepRunner(billing);
    const context = {
      assemble: async () => ({
        channelContext: {},
        sessionContext: { script: "saved script" },
      }),
    };
    const packagingService = new PackagingService(
      packaging,
      projects,
      context as any,
      accounts,
      undefined,
      runner,
    );
    const scriptService = new ContentService(
      content,
      undefined as any,
      projects,
      accounts,
      undefined,
      runner,
    );
    const generate = () =>
      kind === "script"
        ? scriptService.regenerateScript(actor, "script-a")
        : kind === "title"
          ? packagingService.generateTitle(actor, "script", "project-a")
          : kind === "description"
            ? packagingService.generateDescription(
                actor,
                "script",
                "Video",
                "project-a",
              )
            : kind === "thumbnail"
              ? packagingService.generateThumbnail(
                  actor,
                  "script",
                  "Video",
                  "project-a",
                )
              : packagingService.generateShorts(
                  actor,
                  "script",
                  60,
                  "project-a",
                );
    const output = (text: string) =>
      kind === "script"
        ? {
            response: { text: () => text, candidates: [{ finishReason: "STOP" }] },
          }
        : kind === "title"
          ? { titles: [{ title: text, characterCount: text.length }] }
          : kind === "description"
            ? { description: text }
            : kind === "thumbnail"
              ? { descriptions: [text] }
              // Real segment shape (GENERATION_CONFIG_SHORTS, firebase.ts): the
              // text-carrying field is `content`, not `text`/`duration` — this
              // fixture used to use placeholder keys that don't exist in the
              // actual schema, which made a genuinely non-blank segment read as
              // empty once packaging.service checked the real `content` field.
              : { segments: [{ startTime: "0:00", endTime: "0:10", content: text, type: "hook" }], totalDuration: "0:10" };
    let finishFirst!: (value: unknown) => void;
    let finishSecond!: (value: unknown) => void;
    jest
      .mocked(kind === "script" ? generateTextContent : generateStreamingContent)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishFirst = resolve;
          }) as any,
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishSecond = resolve;
          }) as any,
      );
    const first = generate();
    const firstOutcome = first.then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    for (let i = 0; i < 100 && !finishFirst; i++) await Promise.resolve();
    expect(finishFirst).toBeDefined();
    jest.advanceTimersByTime(181000);
    const second = generate();
    for (let i = 0; i < 100 && !finishSecond; i++) await Promise.resolve();
    expect(finishSecond).toBeDefined();
    finishSecond(output("new successful content"));
    await second;
    const saved = clone(
      kind === "script"
        ? row("scripts", "script-a")
        : row("packaging", "project-a"),
    );
    expect(saved).toBeDefined();
    const projectSnapshot = clone(row("videoProjects", "project-a"));
    finishFirst(output("stale successful content"));
    await expect(firstOutcome).resolves.toMatchObject({
      error: { statusCode: 409 },
    });
    expect(
      kind === "script"
        ? row("scripts", "script-a")
        : row("packaging", "project-a"),
    ).toEqual(saved);
    expect(row("videoProjects", "project-a")).toEqual(projectSnapshot);
    expect(row("billing", "owner").consumed).toBe(
      kind === "script" ? 5 : kind === "description" ? 2 : 1,
    );
  },
);
