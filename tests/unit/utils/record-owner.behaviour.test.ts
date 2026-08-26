// The owner stamp on the document shapes themselves.
//
// This suite exists because every OTHER suite that touches these helpers mocks
// them — all nine of them, including the `POST /v1/ideas/generate` integration
// test, which is the highest-volume write path in the system. So the ideas and
// scripts stamps had no real assertion anywhere: the route test's `accountId`
// was a mock return value, not a fact about the written document.
//
// Testing the formatters directly is the only place immune to that. They are
// pure apart from one embedding call, so there is no service or route to stand
// up.

const embedContent = jest.fn().mockResolvedValue({ embedding: { values: [0.1, 0.2] } });

jest.mock("../../../src/config/ai", () => ({ embeddingModel: { embedContent } }));
jest.mock("../../../src/config/firebase", () => ({
  db: {},
  firebase: { firestore: { FieldValue: { serverTimestamp: () => "server-ts" } } },
}));

import {
  formatGeneratedIdea,
  formatGeneratedScript,
  formatGeneratedTitle,
} from "../../../src/utlils/content";
import { TEST_ACCOUNT_ID } from "../../helpers/account";

const OWNER = { userId: "user-1", accountId: TEST_ACCOUNT_ID };

// Both fields, every shape. A record written without `accountId` looks completely
// normal until Phase 06 switches reads, at which point it goes invisible to its
// owner — indistinguishable from data loss, weeks after the backfill scanned past
// it. And `accountId` must never equal the uid: that shortcut is dead precisely
// because a uid-where-an-accountId-belongs bug still isolates correctly between
// two users, so nothing downstream can see it.
describe.each([
  [
    "idea (POST /v1/ideas/generate — the highest-volume write)",
    () =>
      formatGeneratedIdea(
        { workingTitle: "My Idea", concept: "c", type: "long", evidence: "e" },
        OWNER,
        "batch-1"
      ),
  ],
  ["bring-your-own title", () => formatGeneratedTitle("My Title", OWNER, "batch-1")],
  [
    "script (SSE route — served only by Render)",
    async () =>
      formatGeneratedScript("T", "script-1", "idea-1", "proj-1", "body", OWNER),
  ],
])("%s carries both owner fields", (_label, build) => {
  it("stamps createdBy and accountId, and they are different values", async () => {
    const doc = (await build()) as Record<string, unknown>;

    expect(doc.createdBy).toBe("user-1");
    expect(doc.accountId).toBe(TEST_ACCOUNT_ID);
    expect(doc.accountId).not.toBe(doc.createdBy);
  });

  it("never emits an empty-string owner", async () => {
    // `""` is worse than absent: it is a real value every orphaned record across
    // every user shares, so the backfill would bucket unrelated users together.
    const doc = (await build()) as Record<string, unknown>;

    expect(doc.createdBy).not.toBe("");
    expect(doc.accountId).not.toBe("");
  });
});

// The positional-argument trap this phase actually hit: `userId` and `accountId`
// are both strings, so `formatGeneratedIdea(idea, userId, batchId)` kept compiling
// with `batchId` sitting in the account slot. The object parameter is what makes
// that a compile error — this asserts the runtime half, that the two ids are read
// from their own keys rather than by position.
describe("the owner is read by key, not by position", () => {
  // Read through `Record<string, unknown>`, like the block above. Reading the
  // inferred type instead turns a dropped stamp into a suite-wide COMPILE error,
  // which takes the other assertions down with it and reports a type mismatch in
  // the test rather than naming the missing field in the document.
  it("does not confuse batchId with accountId", async () => {
    const doc = (await formatGeneratedIdea(
      { workingTitle: "T", concept: null, type: "long", evidence: null },
      OWNER,
      "batch-1"
    )) as Record<string, unknown>;

    expect(doc.batchId).toBe("batch-1");
    expect(doc.accountId).toBe(TEST_ACCOUNT_ID);
    expect(doc.accountId).not.toBe("batch-1");
  });

  it("still stamps the account when there is no batch at all", async () => {
    const doc = (await formatGeneratedTitle("T", OWNER)) as Record<string, unknown>;

    expect(doc.batchId).toBeNull();
    expect(doc.accountId).toBe(TEST_ACCOUNT_ID);
  });
});
