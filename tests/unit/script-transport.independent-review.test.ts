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

const originalFetch = global.fetch;
beforeEach(() => { jest.useFakeTimers(); });
afterEach(() => { global.fetch = originalFetch; jest.clearAllTimers(); jest.useRealTimers(); });
const responseBody = (text: string, finishReason = "STOP") => ({ candidates: [{ index: 0, content: { role: "model", parts: [{ text }] }, finishReason }] });
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
function installResponse(body: string, status = 200) {
  // Chunk in the middle of UTF-8 codepoints and JSON escapes, like real transport.
  global.fetch = jest.fn().mockImplementation(async () => new Response(new ReadableStream({
    start(controller) {
      const bytes = new TextEncoder().encode(body);
      for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7));
      controller.close();
    },
  }), { status, headers: { "Content-Type": "application/json" } }));
}
it("regenerates through SDK generateContent JSON preserving the entire manuscript and current idea context", async () => {
  const { service, owner, charge, billing, repo, projects } = setup();
  const manuscript = ("Scene: café 🎬\nQuoted: \"hello\"\n\n".repeat(300)) + "FINAL SCENE";
  installResponse(JSON.stringify(responseBody(manuscript)));
  await expect(service.regenerateScript(owner, "s")).resolves.toEqual({ id: "s", title: "Saved title", script: manuscript });
  expect(global.fetch).toHaveBeenCalledTimes(1);
  const [url, request] = (global.fetch as jest.Mock).mock.calls[0];
  expect(url).toMatch(/:generateContent$/);
  expect(url).not.toMatch(/streamGenerateContent|alt=sse/);
  const body = JSON.parse(request.body);
  expect(body.contents[0].parts[0].text).toContain("Latest idea title");
  expect(body.contents[0].parts[0].text).toContain("Preserve idea concept");
  expect(body.contents[0].parts[0].text).toContain("Preserve evidence");
  expect(repo.editScript).toHaveBeenCalledWith("s", { script: manuscript }, charge);
  expect(repo.editScript).toHaveBeenCalledTimes(1);
  expect(projects.markStale).toHaveBeenCalledWith("p", "script", charge);
  expect(projects.markPackagingDocumentStale).toHaveBeenCalledWith("p", "script_regenerated", charge);
  expect(billing.settle).toHaveBeenCalledWith(charge, false);
});

it.each([
  ["truncated JSON", '{"candidates":', 200],
  ["SSE body on JSON endpoint", 'data: {"candidates":[]}\n\n', 200],
  ["MAX_TOKENS with partial text", JSON.stringify(responseBody("partial draft", "MAX_TOKENS")), 200],
  ["SAFETY with partial text", JSON.stringify(responseBody("partial draft", "SAFETY")), 200],
  ["missing finish metadata", JSON.stringify({ candidates: [{ content: { parts: [{ text: "apparently complete" }] } }] }), 200],
  ["prompt blocked", JSON.stringify({ promptFeedback: { blockReason: "SAFETY" } }), 200],
  ["empty manuscript", JSON.stringify(responseBody("  ")), 200],
  ["busy provider", JSON.stringify({ error: { message: "busy" } }), 503],
].flatMap(([label, body, status]) => [true, false].map(debited => [label, body, status, debited] as const)))("rejects %s without write, charge or downstream invalidation (metered=%s)", async (_label, body, status, debited) => {
  const { service, owner, charge, billing, saved, repo, projects } = setup(debited);
  installResponse(body as string, status as number);
  const rejection = expect(service.regenerateScript(owner, "s")).rejects.toMatchObject({ statusCode: 503, ...(debited ? { detail: { charged: false } } : {}) });
  if (status === 503) await jest.advanceTimersByTimeAsync(2_000);
  await rejection;
  expect(global.fetch).toHaveBeenCalledTimes(status === 503 ? 3 : 1);
  expect(billing.reserve).toHaveBeenCalledTimes(1);
  expect(billing.settle).toHaveBeenCalledTimes(1);
  expect(billing.settle).toHaveBeenCalledWith(charge, true);
  expect(repo.editScript).not.toHaveBeenCalled();
  expect(repo.saveScript).not.toHaveBeenCalled();
  expect(repo.updateIdea).not.toHaveBeenCalled();
  expect(saved.script).toBe("Original hand-edited manuscript");
  expect(projects.linkResource).not.toHaveBeenCalled();
  expect(projects.completeStep).not.toHaveBeenCalled();
  expect(projects.markStale).not.toHaveBeenCalled();
  expect(projects.markPackagingDocumentStale).not.toHaveBeenCalled();
});

it("rejects an interrupted JSON body without retrying or saving", async () => {
  const { service, owner, charge, billing, repo, projects } = setup();
  global.fetch = jest.fn().mockImplementation(async () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"candidates":'));
      controller.error(new TypeError("terminated"));
    },
  })));
  await expect(service.regenerateScript(owner, "s")).rejects.toMatchObject({ statusCode: 503, detail: { charged: false } });
  expect(global.fetch).toHaveBeenCalledTimes(1);
  expect(repo.editScript).not.toHaveBeenCalled();
  expect(projects.markStale).not.toHaveBeenCalled();
  expect(projects.markPackagingDocumentStale).not.toHaveBeenCalled();
  expect(billing.settle).toHaveBeenCalledWith(charge, true);
});

it("aborts a stalled JSON body at 120 seconds and releases the reservation once", async () => {
  const { service, owner, charge, billing, repo } = setup();
  global.fetch = jest.fn().mockImplementation(async (_url, options) => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"candidates":'));
      options.signal.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")));
    },
  })));
  const run = service.regenerateScript(owner, "s");
  const rejection = expect(run).rejects.toMatchObject({ statusCode: 503, detail: { charged: false } });
  await jest.advanceTimersByTimeAsync(120_000);
  await rejection;
  expect(global.fetch).toHaveBeenCalledTimes(1);
  expect(repo.editScript).not.toHaveBeenCalled();
  expect(billing.settle).toHaveBeenCalledTimes(1);
  expect(billing.settle).toHaveBeenCalledWith(charge, true);
  expect(jest.getTimerCount()).toBe(0);
});

it("recovers rejected 503 responses within one reservation and saves once", async () => {
  const { service, owner, charge, billing, repo } = setup();
  const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
  global.fetch = jest.fn()
    .mockResolvedValueOnce(new Response("private provider body", { status: 503 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: "private detail" } }), { status: 503 }))
    .mockResolvedValueOnce(new Response(JSON.stringify(responseBody("Complete replacement"))));
  const run = service.regenerateScript(owner, "s");
  await jest.advanceTimersByTimeAsync(2_000);
  await expect(run).resolves.toMatchObject({ script: "Complete replacement" });
  expect(global.fetch).toHaveBeenCalledTimes(3);
  expect(new Set((global.fetch as jest.Mock).mock.calls.map(call => call[1].body)).size).toBe(1);
  expect(billing.reserve).toHaveBeenCalledTimes(1);
  expect(repo.editScript).toHaveBeenCalledTimes(1);
  expect(billing.settle).toHaveBeenCalledTimes(1);
  expect(billing.settle).toHaveBeenCalledWith(charge, false);
  expect(warn.mock.calls.map(call => JSON.parse(call[0]))).toEqual([1, 2].map(attempt => ({
    event: "ai_provider_busy", attempt, status: 503, model: "gemini-3.8-flash", transport: "json",
  })));
  warn.mockRestore();
  expect(jest.getTimerCount()).toBe(0);
});

it.each(["malformed body", "network failure"])("does not replay %s following a definite busy rejection", async failure => {
  const { service, owner, charge, billing, repo } = setup();
  const fetchMock = jest.fn().mockResolvedValueOnce(new Response("busy", { status: 503 }));
  if (failure === "malformed body") fetchMock.mockResolvedValueOnce(new Response('{"candidates":'));
  else fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
  global.fetch = fetchMock;
  const rejection = expect(service.regenerateScript(owner, "s")).rejects.toBeDefined();
  await jest.advanceTimersByTimeAsync(2_000);
  await rejection;
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(repo.editScript).not.toHaveBeenCalled();
  expect(billing.reserve).toHaveBeenCalledTimes(1);
  expect(billing.settle).toHaveBeenCalledTimes(1);
  expect(billing.settle).toHaveBeenCalledWith(charge, true);
  expect(jest.getTimerCount()).toBe(0);
});

it("keeps the original deadline when a rejected busy request consumes the budget", async () => {
  const { service, owner, billing, repo } = setup();
  global.fetch = jest.fn().mockImplementation(async () => {
    await new Promise(resolve => setTimeout(resolve, 119_800));
    return new Response("busy", { status: 503 });
  });
  const rejection = expect(service.regenerateScript(owner, "s")).rejects.toMatchObject({ statusCode: 503 });
  await jest.advanceTimersByTimeAsync(120_000);
  await rejection;
  expect(global.fetch).toHaveBeenCalledTimes(1);
  expect(repo.editScript).not.toHaveBeenCalled();
  expect(billing.settle).toHaveBeenCalledTimes(1);
  expect(jest.getTimerCount()).toBe(0);
});

it("includes retry backoff and the retried response body in the original deadline", async () => {
  const { service, owner, charge, billing, repo } = setup();
  const started = Date.now();
  global.fetch = jest.fn()
    .mockResolvedValueOnce(new Response("busy", { status: 503 }))
    .mockImplementationOnce(async (_url, options) => new Response(new ReadableStream({
      start(controller) {
        options.signal.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")));
      },
    })));
  const rejection = expect(service.regenerateScript(owner, "s")).rejects.toMatchObject({ statusCode: 503, detail: { charged: false } });
  await jest.advanceTimersByTimeAsync(119_999);
  expect(global.fetch).toHaveBeenCalledTimes(2);
  expect(billing.settle).not.toHaveBeenCalled();
  await jest.advanceTimersByTimeAsync(1);
  await rejection;
  expect(Date.now() - started).toBe(120_000);
  expect(global.fetch).toHaveBeenCalledTimes(2);
  expect(repo.editScript).not.toHaveBeenCalled();
  expect(billing.reserve).toHaveBeenCalledTimes(1);
  expect(billing.settle).toHaveBeenCalledTimes(1);
  expect(billing.settle).toHaveBeenCalledWith(charge, true);
  expect(jest.getTimerCount()).toBe(0);
});

it("never regenerates after persistence fails following provider recovery", async () => {
  const { service, owner, charge, billing, repo, projects } = setup();
  repo.editScript.mockRejectedValueOnce(new Error("storage unavailable"));
  global.fetch = jest.fn()
    .mockResolvedValueOnce(new Response("busy", { status: 503 }))
    .mockResolvedValueOnce(new Response(JSON.stringify(responseBody("Complete replacement"))));
  const rejection = expect(service.regenerateScript(owner, "s")).rejects.toBeDefined();
  await jest.advanceTimersByTimeAsync(2_000);
  await rejection;
  expect(global.fetch).toHaveBeenCalledTimes(2);
  expect(repo.editScript).toHaveBeenCalledTimes(1);
  expect(projects.markStale).not.toHaveBeenCalled();
  expect(projects.markPackagingDocumentStale).not.toHaveBeenCalled();
  expect(billing.reserve).toHaveBeenCalledTimes(1);
  expect(billing.settle).toHaveBeenCalledTimes(1);
  expect(billing.settle).toHaveBeenCalledWith(charge, true);
  expect(jest.getTimerCount()).toBe(0);
});
