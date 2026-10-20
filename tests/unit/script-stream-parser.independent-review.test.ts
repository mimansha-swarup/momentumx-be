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

import ContentService from "../../src/service/content.service";
import StepRunner from "../../src/service/step-runner";
import { generateStreamingContent } from "../../src/utlils/ai";
import { fakeAccountRepo, testOwner, TEST_ACCOUNT_ID } from "../helpers/account";
import type { CreditReservation } from "../../src/repository/billing.repository";

const originalFetch = global.fetch;
const textFrame = 'data: ' + JSON.stringify({ candidates: [{ index: 0, content: { role: "model", parts: [{ text: "Partial body" }] } }] }) + "\n\n";
const finishFrame = 'data: ' + JSON.stringify({ candidates: [{ index: 0, finishReason: "STOP" }] }) + "\n\n";
const wireResponse = (wire: string) => new Response(new ReadableStream({
  start(controller) {
    const bytes = new TextEncoder().encode(wire);
    // Exercise arbitrary transport splits, including the SSE delimiter.
    for (let i = 0; i < bytes.length; i += 3) controller.enqueue(bytes.slice(i, i + 3));
    controller.close();
  },
}), { headers: { "Content-Type": "text/event-stream" } });
beforeEach(() => { jest.useFakeTimers(); });
afterEach(() => { global.fetch = originalFetch; jest.clearAllTimers(); jest.useRealTimers(); });

it.each([
  ["initial", 'data: {"candidates":'],
  ["regenerate", 'data: {"candidates":'],
  ["initial", 'data: {broken}\n\n'],
  ["regenerate", 'data: {broken}\n\n'],
].flatMap(([mode, tail]) => [true, false].map(debited => [mode, tail, debited] as const)))("%s preserves saved content after real SDK response parser error (%s), metering=%s", async (mode, badTail, debited) => {
  const owner = testOwner("completion-review");
  const charge: CreditReservation = { ownerUid: owner.userId, accountId: owner.accountId, actorUserId: owner.userId, periodStart: "2026-10", cost: 1, debited, counter: "script", lockKey: "review-lock", token: "review-token", kind: "script", projectId: "p" };
  const billing = { reserve: jest.fn().mockResolvedValue(charge), settle: jest.fn().mockResolvedValue(true) };
  const saved = { accountId: TEST_ACCOUNT_ID, title: "A real concept", script: "Original hand-edited manuscript", ideaId: "i", videoProjectId: "p" };
  const repo = { getScriptById: jest.fn().mockResolvedValue(saved), getIdea: jest.fn().mockResolvedValue({ accountId: TEST_ACCOUNT_ID, title: "A real concept", concept: "Explain a choice", ideaType: "long" }), editScript: jest.fn(), saveScript: jest.fn(), updateIdea: jest.fn() };
  const projects = { getById: jest.fn().mockResolvedValue({ id: "p", ideaId: "i", scriptId: null }), linkResource: jest.fn(), completeStep: jest.fn(), markStale: jest.fn(), markPackagingDocumentStale: jest.fn() };
  const service = new ContentService(repo as any, { update: jest.fn() } as any, projects as any, fakeAccountRepo(), undefined, new StepRunner(billing));
  global.fetch = jest.fn().mockResolvedValue(mode === "initial" ? wireResponse(textFrame + badTail) : new Response('{"candidates":', { headers: { "Content-Type": "application/json" } }));
  const res = { setHeader: jest.fn(), flushHeaders: jest.fn(), write: jest.fn(), end: jest.fn() };
  await expect(mode === "initial" ? service.generateScripts(owner, "p", res as any) : service.regenerateScript(owner, "s"))
    .rejects.toMatchObject({ statusCode: 503, message: "Generation was interrupted before a complete response arrived. Please try again.", ...(debited ? { detail: { charged: false } } : {}) });
  expect(global.fetch).toHaveBeenCalledTimes(1);
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

it("accepts valid real SDK SSE across arbitrary transport boundaries", async () => {
  global.fetch = jest.fn().mockResolvedValue(wireResponse(textFrame + finishFrame));
  const result = await generateStreamingContent("system", "user", {});
  let text = "";
  for await (const chunk of result.stream) text += chunk.text();
  expect(text).toBe("Partial body");
  expect((await result.response).candidates?.[0].finishReason).toBe("STOP");
  expect(global.fetch).toHaveBeenCalledTimes(1);
});

it.each(['data: {"candidates":', 'data: {broken}\n\n'])("observes the real SDK aggregate rejection when only stream is consumed (%s)", async tail => {
  global.fetch = jest.fn().mockResolvedValue(wireResponse(textFrame + tail));
  const result = await generateStreamingContent("system", "user", {});
  const consume = async () => { for await (const chunk of result.stream) chunk.text(); };
  await expect(consume()).rejects.toMatchObject({ statusCode: 503 });
  // Allow an event-loop turn: an unobserved aggregate rejection fails Jest here.
  await new Promise<void>(resolve => jest.requireActual("node:timers").setImmediate(resolve));
  await expect(result.response).rejects.toThrow(/Failed to parse stream|Error parsing JSON response/);
  expect(global.fetch).toHaveBeenCalledTimes(1);
});
