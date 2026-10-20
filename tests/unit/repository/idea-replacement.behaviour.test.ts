jest.mock("../../../src/config/firebase", () => require("../../helpers/fake-firestore").mockFirebase());

import BillingRepository from "../../../src/repository/billing.repository";
import ContentRepository from "../../../src/repository/content.repository";
import { FakeFirestore, fakeTimestamp } from "../../helpers/fake-firestore";

const store: FakeFirestore = require("../../../src/config/firebase").__db;
const repo = new ContentRepository();
const billing = new BillingRepository();
const actor = { userId: "editor", accountId: "channel" };
const idea = (id: string, accountId = actor.accountId) => ({
  id, title: id, accountId, batchId: id, archived: false, createdAt: fakeTimestamp(Date.now()),
});

beforeEach(() => {
  process.env.MONTHLY_CREDIT_ALLOWANCE = "50";
  store.data.clear();
  store.seed("accounts", [{ id: "channel", billingOwnerUid: "payer", members: { editor: { role: "editor" } } }]);
  store.seed("ideas", [idea("old"), idea("other", "other-channel")]);
});
afterEach(() => jest.restoreAllMocks());

it("refreshes only the replacement after delivery even if the old archive helper is unavailable", async () => {
  jest.spyOn(repo, "archiveUserIdeas").mockRejectedValue(new Error("archive unavailable"));
  const charge = await billing.reserve({ actor, kind: "ideas" });
  await repo.batchSaveIdeas([idea("new")], charge, actor.accountId);

  expect((await repo.getActiveBatch(actor.accountId)).map(row => row.id)).toEqual(["new"]);
  expect((await repo.getIdeas({ accountId: actor.accountId, limit: 8, cursor: {}, filters: {} })).map(row => row.id)).toEqual(["new"]);
  expect((await repo.getActiveBatch("other-channel")).map(row => row.id)).toEqual(["other"]);
  expect(store.col("ideas").get("old")!.archived).toBe(true);
  expect(store.col("billing").get("payer")!.consumed).toBe(charge!.cost);
  expect(repo.archiveUserIdeas).not.toHaveBeenCalled();
});

it("rolls back old archival, replacement and accounting together when the commit aborts", async () => {
  const charge = await billing.reserve({ actor, kind: "ideas" });
  const original = store.runTransaction.bind(store);
  jest.spyOn(store, "runTransaction").mockImplementationOnce(fn => original(async tx => {
    await fn(tx);
    throw new Error("ABORTED");
  }));
  jest.spyOn(console, "error").mockImplementation(() => {});
  await expect(repo.batchSaveIdeas([idea("new")], charge, actor.accountId)).rejects.toThrow("ABORTED");
  expect((await repo.getActiveBatch(actor.accountId)).map(row => row.id)).toEqual(["old"]);
  expect(store.col("ideas").has("new")).toBe(false);
  expect(store.col("billing").get("payer")!.consumed).toBe(0);
});

it("keeps ordinary generation additive and rejects cross-channel replacements", async () => {
  await repo.batchSaveIdeas([idea("more")]);
  expect((await repo.getActiveBatch(actor.accountId)).map(row => row.id).sort()).toEqual(["more", "old"]);
  jest.spyOn(console, "error").mockImplementation(() => {});
  await expect(repo.batchSaveIdeas([idea("wrong", "other-channel")], null, actor.accountId)).rejects.toThrow("channel being replaced");
  expect(store.col("ideas").has("wrong")).toBe(false);
  expect(store.col("ideas").get("old")!.archived).toBe(false);
});

it("refuses oversized atomic replacements without archiving, delivering or charging", async () => {
  store.seed("ideas", Array.from({ length: 451 }, (_, i) => idea(`old-${i}`)));
  const charge = await billing.reserve({ actor, kind: "ideas" });
  jest.spyOn(console, "error").mockImplementation(() => {});
  await expect(repo.batchSaveIdeas([idea("new")], charge, actor.accountId)).rejects.toMatchObject({
    statusCode: 503, message: expect.stringContaining("existing ideas are unchanged"),
  });
  expect(store.col("ideas").has("new")).toBe(false);
  expect([...store.col("ideas").values()].every(row => row.archived === false)).toBe(true);
  expect(store.col("billing").get("payer")!.consumed).toBe(0);
});
