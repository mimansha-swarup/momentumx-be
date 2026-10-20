jest.mock("firebase-admin", () => ({
  apps: [],
  initializeApp: jest.fn(),
  credential: { cert: jest.fn() },
  firestore: Object.assign(jest.fn().mockReturnValue({}), {
    FieldValue: { serverTimestamp: jest.fn(), increment: jest.fn((n: number) => ({ _increment: n })) },
    FieldPath: { documentId: jest.fn() },
    Timestamp: { now: jest.fn() },
  }),
  auth: jest.fn().mockReturnValue({ verifyIdToken: jest.fn() }),
}));

jest.mock("../../src/config/firebase", () => ({
  db: {},
  auth: {},
  firebase: {
    firestore: {
      FieldValue: { serverTimestamp: jest.fn(), increment: jest.fn((n: number) => ({ _increment: n })) },
      FieldPath: { documentId: jest.fn() },
    },
  },
}));

jest.mock("../../src/utlils/ai", () => ({
  // collectJson stays REAL: it is the empty/malformed-JSON guard, and the fake
  // streams below are exactly what should be driving it.
  collectJson: jest.requireActual("../../src/utlils/ai").collectJson,
  generateContent: jest.fn(),
  generateStreamingContent: jest.fn(),
  generateTextContent: jest.fn(),
}));

import ContentService from "../../src/service/content.service";
import StepRunner from "../../src/service/step-runner";
import { generateStreamingContent, generateTextContent } from "../../src/utlils/ai";
import { fakeAccountRepo, testOwner, TEST_ACCOUNT_ID } from "../helpers/account";
import type { CreditReservation } from "../../src/repository/billing.repository";

it.each(["initial", "regenerate"])("%s releases its reservation without writing or downstream changes on incomplete output", async mode => {
  const owner = testOwner("completion-review");
  const charge: CreditReservation = { ownerUid: owner.userId, accountId: owner.accountId, actorUserId: owner.userId, periodStart: "2026-10", cost: 1, debited: true, counter: "script", lockKey: "review-lock", token: "review-token", kind: "script", projectId: "p" };
  const billing = { reserve: jest.fn().mockResolvedValue(charge), settle: jest.fn().mockResolvedValue(true) };
  const saved = { accountId: TEST_ACCOUNT_ID, title: "A real concept", script: "Original hand-edited manuscript", ideaId: "i", videoProjectId: "p" };
  const repo = { getScriptById: jest.fn().mockResolvedValue(saved), getIdea: jest.fn().mockResolvedValue({ accountId: TEST_ACCOUNT_ID, title: "A real concept", concept: "Explain a choice", ideaType: "long" }), editScript: jest.fn(), saveScript: jest.fn(), updateIdea: jest.fn() };
  const projects = { getById: jest.fn().mockResolvedValue({ id: "p", ideaId: "i", scriptId: null }), linkResource: jest.fn(), completeStep: jest.fn(), markStale: jest.fn(), markPackagingDocumentStale: jest.fn() };
  const service = new ContentService(repo as any, { update: jest.fn() } as any, projects as any, fakeAccountRepo(), undefined, new StepRunner(billing));
  (generateStreamingContent as jest.Mock).mockResolvedValue({ stream: (async function* () { yield { text: () => "Partial body" }; })(), response: Promise.resolve({ candidates: [{ finishReason: "MAX_TOKENS" }] }) });
  (generateTextContent as jest.Mock).mockResolvedValue({ response: { text: () => "Partial body", candidates: [{ finishReason: "MAX_TOKENS" }] } });
  const res = { setHeader: jest.fn(), flushHeaders: jest.fn(), write: jest.fn(), end: jest.fn() };
  await expect(mode === "initial" ? service.generateScripts(owner, "p", res as any) : service.regenerateScript(owner, "s"))
    .rejects.toMatchObject({ statusCode: 503, detail: { charged: false } });
  expect(billing.reserve).toHaveBeenCalledTimes(1);
  expect(billing.settle).toHaveBeenCalledTimes(1);
  expect(billing.settle).toHaveBeenCalledWith(charge, true);
  expect(repo.saveScript).not.toHaveBeenCalled();
  expect(repo.editScript).not.toHaveBeenCalled();
  expect(repo.updateIdea).not.toHaveBeenCalled();
  expect(saved.script).toBe("Original hand-edited manuscript");
  expect(projects.linkResource).not.toHaveBeenCalled();
  expect(projects.completeStep).not.toHaveBeenCalled();
  expect(projects.markStale).not.toHaveBeenCalled();
  expect(projects.markPackagingDocumentStale).not.toHaveBeenCalled();
  expect(res.write).not.toHaveBeenCalledWith("data: [DONE]\n\n");
});
