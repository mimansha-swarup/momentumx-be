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

// Real installed SDK and AI wrapper; only the network and persistence are mocked.
import ContentService from "../../src/service/content.service";
import StepRunner from "../../src/service/step-runner";
import { fakeAccountRepo, testOwner, TEST_ACCOUNT_ID } from "../helpers/account";
import type { CreditReservation } from "../../src/repository/billing.repository";

import { streamScript } from "../../src/utlils/ai";

const originalFetch = global.fetch;
const frame = (text: string, finishReason?: string) => `data: ${JSON.stringify({ candidates: [{ index: 0, content: { role: "model", parts: [{ text }] }, ...(finishReason ? { finishReason } : {}) }] })}\n\n`;
const response = (body: string) => new Response(new ReadableStream({ start(controller) {
  const bytes = new TextEncoder().encode(body);
  for (let i = 0; i < bytes.length; i += 3) controller.enqueue(bytes.slice(i, i + 3));
  controller.close();
} }), { headers: { "Content-Type": "text/event-stream" } });
afterEach(() => { global.fetch = originalFetch; jest.useRealTimers(); });

it("delivers actual SDK text before provider completion and preserves fragmented UTF-8", async () => {
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  global.fetch = jest.fn().mockResolvedValue(new Response(new ReadableStream({ start(controller) { stream = controller; } }), { headers: { "Content-Type": "text/event-stream" } }));
  const chunks: string[] = [];
  let first!: () => void;
  const received = new Promise<void>(resolve => { first = resolve; });
  const pending = streamScript("instructions", "context", text => { chunks.push(text); first(); });
  stream.enqueue(new TextEncoder().encode(frame("First words")));
  await received;
  expect(chunks).toEqual(["First words"]);
  stream.enqueue(new TextEncoder().encode(frame(" — café 🎬", "STOP")));
  stream.close();
  await expect(pending).resolves.toBe("First words — café 🎬");
  expect(global.fetch).toHaveBeenCalledTimes(1);
});

it("handles SDK byte fragmentation and confirms STOP before returning", async () => {
  global.fetch = jest.fn().mockResolvedValue(response(frame("café 🎬\n") + frame("Complete", "STOP")));
  const chunk = jest.fn();
  await expect(streamScript("instructions", "context", chunk)).resolves.toBe("café 🎬\nComplete");
  expect(chunk.mock.calls.flat().join("")).toBe("café 🎬\nComplete");
});

it.each([
  ["missing completion", frame("partial")],
  ["MAX_TOKENS", frame("partial", "MAX_TOKENS")],
  ["blocked", frame("", "SAFETY")],
  ["malformed JSON", 'data: {not-json}\n\n'],
  ["truncated framing", 'data: {"candidates":'],
])("rejects %s without replay", async (_name, body) => {
  global.fetch = jest.fn().mockResolvedValue(response(body));
  await expect(streamScript("instructions", "context", jest.fn())).rejects.toMatchObject({ statusCode: 503 });
  expect(global.fetch).toHaveBeenCalledTimes(1);
});

it("does not let SDK default retry quota failures", async () => {
  global.fetch = jest.fn().mockResolvedValue(new Response(JSON.stringify({ error: { code: 429, message: "Quota exceeded", details: [{ "@type": "type.googleapis.com/google.rpc.QuotaFailure", violations: [{ quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier" }] }] } }), { status: 429, headers: { "Content-Type": "application/json" } }));
  await expect(streamScript("instructions", "context", jest.fn())).rejects.toMatchObject({ statusCode: 429, code: "provider_quota_exceeded" });
  expect(global.fetch).toHaveBeenCalledTimes(1);
});

it("retries only explicit pre-stream 503 and exposes honest progress", async () => {
  jest.useFakeTimers();
  global.fetch = jest.fn().mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: 503, message: "busy" } }), { status: 503 })).mockResolvedValueOnce(response(frame("done", "STOP")));
  const progress = jest.fn();
  const pending = streamScript("instructions", "context", jest.fn(), progress);
  const assertion = expect(pending).resolves.toBe("done");
  await jest.advanceTimersByTimeAsync(1500);
  await assertion;
  expect(global.fetch).toHaveBeenCalledTimes(2);
  expect(progress).toHaveBeenCalledWith("provider_busy", expect.any(String));
});

function setup(debited = true) {
  const owner = testOwner("transport-review");
  const charge: CreditReservation = { ownerUid: owner.userId, accountId: owner.accountId, actorUserId: owner.userId, periodStart: "2026-10", cost: 1, debited, counter: "script", lockKey: "review-lock", token: "review-token", kind: "script", projectId: "p" };
  const billing = { reserve: jest.fn().mockResolvedValue(charge), settle: jest.fn().mockResolvedValue(true) };
  const saved = { accountId: TEST_ACCOUNT_ID, title: "Saved title", script: "Original hand-edited manuscript", ideaId: "i", videoProjectId: "p" };
  const repo = { getScriptById: jest.fn().mockResolvedValue(saved), getIdea: jest.fn().mockResolvedValue({ accountId: TEST_ACCOUNT_ID, title: "Latest idea title", concept: "Preserve idea concept", ideaType: "long", evidence: "Preserve evidence" }), editScript: jest.fn(), saveScript: jest.fn(), updateIdea: jest.fn() };
  const projects = { getById: jest.fn().mockResolvedValue({ id: "p", ideaId: "i", scriptId: "s" }), linkResource: jest.fn(), completeStep: jest.fn(), markStale: jest.fn(), markPackagingDocumentStale: jest.fn() };
  const service = new ContentService(repo as any, { update: jest.fn() } as any, projects as any, fakeAccountRepo(), undefined, new StepRunner(billing));
  return { service, owner, charge, billing, saved, repo, projects };
}

it("preserves the old script until validated streaming completion, then saves and settles once", async () => {
  const { service, owner, charge, repo, billing, projects } = setup();
  let source!: ReadableStreamDefaultController<Uint8Array>;
  global.fetch = jest.fn().mockResolvedValue(new Response(new ReadableStream({ start(controller) { source = controller; } }), { headers: { "Content-Type": "text/event-stream" } }));
  let first!: () => void;
  const received = new Promise<void>(resolve => { first = resolve; });
  const pending = service.regenerateScript(owner, "s", jest.fn(), () => first());
  source.enqueue(new TextEncoder().encode(frame("Replacement")));
  await received;
  expect(repo.editScript).not.toHaveBeenCalled();
  expect(projects.markStale).not.toHaveBeenCalled();
  expect(billing.settle).not.toHaveBeenCalled();
  source.enqueue(new TextEncoder().encode(frame(" done", "STOP")));
  source.close();
  await expect(pending).resolves.toEqual({ id: "s", title: "Saved title", script: "Replacement done" });
  expect(repo.editScript).toHaveBeenCalledWith("s", { script: "Replacement done" }, charge);
  expect(billing.settle).toHaveBeenCalledTimes(1);
  expect(billing.settle).toHaveBeenCalledWith(charge, false);
});
it("partial provider failure never updates old script or downstream and releases the reservation", async () => {
  const { service, owner, charge, repo, billing, projects } = setup();
  global.fetch = jest.fn().mockResolvedValue(response(frame("Partial", "MAX_TOKENS")));
  await expect(service.regenerateScript(owner, "s", jest.fn(), jest.fn())).rejects.toMatchObject({ statusCode: 503, detail: { charged: false } });
  expect(repo.editScript).not.toHaveBeenCalled();
  expect(projects.markStale).not.toHaveBeenCalled();
  expect(billing.settle).toHaveBeenCalledWith(charge, true);
  expect(global.fetch).toHaveBeenCalledTimes(1);
});

it("aborts a stalled body at the shared deadline without replay or save", async () => {
  jest.useFakeTimers();
  const { service, owner, billing, repo } = setup();
  global.fetch = jest.fn().mockImplementation(async (_url, init) => new Response(new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode(frame("Partial")));
    init.signal.addEventListener("abort", () => controller.error(new DOMException("Aborted", "AbortError")), { once: true });
  } }), { headers: { "Content-Type": "text/event-stream" } }));
  const pending = service.regenerateScript(owner, "s", jest.fn(), jest.fn());
  const assertion = expect(pending).rejects.toMatchObject({ statusCode: 503, detail: { charged: false } });
  await jest.advanceTimersByTimeAsync(120_001);
  await assertion;
  expect(repo.editScript).not.toHaveBeenCalled();
  expect(global.fetch).toHaveBeenCalledTimes(1);
  expect(billing.settle).toHaveBeenCalledTimes(1);
});

it("does not resolve success until save and settlement finish", async () => {
  const { service, owner, billing, repo } = setup();
  global.fetch = jest.fn().mockResolvedValue(response(frame("Complete", "STOP")));
  let save!: () => void;
  let settle!: () => void;
  let started!: () => void;
  const saving = new Promise<void>(resolve => { started = resolve; });
  repo.editScript.mockImplementation(() => { started(); return new Promise<void>(resolve => { save = resolve; }); });
  billing.settle.mockImplementation(() => new Promise<boolean>(resolve => { settle = () => resolve(true); }));
  let completed = false;
  const pending = service.regenerateScript(owner, "s", jest.fn(), jest.fn()).then(data => { completed = true; return data; });
  await saving;
  expect(completed).toBe(false);
  expect(billing.settle).not.toHaveBeenCalled();
  save();
  // Let the existing downstream writes finish before the settlement gate.
  for (let i = 0; i < 20 && !settle; i++) await Promise.resolve();
  expect(settle).toBeDefined();
  expect(completed).toBe(false);
  settle();
  await expect(pending).resolves.toMatchObject({ script: "Complete" });
});

it("releases the reservation after a save failure without replay", async () => {
  const { service, owner, charge, repo, billing, projects } = setup();
  global.fetch = jest.fn().mockResolvedValue(response(frame("Complete", "STOP")));
  repo.editScript.mockRejectedValue(new Error("storage unavailable"));
  await expect(service.regenerateScript(owner, "s", jest.fn(), jest.fn())).rejects.toMatchObject({ detail: { charged: false } });
  expect(billing.settle).toHaveBeenCalledWith(charge, true);
  expect(projects.markStale).not.toHaveBeenCalled();
  expect(global.fetch).toHaveBeenCalledTimes(1);
});
