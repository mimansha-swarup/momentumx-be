/** Independent mounted HTTP acceptance. Real route/controller/service/StepRunner;
 * synthetic account, persistence and provider boundaries; no external calls. */
jest.mock("../../src/config/firebase", () => ({
  db: {},
  auth: { verifyIdToken: async () => ({ uid: "reviewer" }) },
  firebase: {
    auth: () => ({ verifyIdToken: async () => ({ uid: "reviewer" }) }),
    firestore: {
      FieldValue: { increment: (n: number) => n, serverTimestamp: () => null },
    },
  },
}));
jest.mock("../../src/middleware/account", () =>
  require("../helpers/account").passthroughAccountMiddleware(),
);
jest.mock("../../src/service/event.service", () => ({
  eventService: { capture: jest.fn(), track: jest.fn(), log: jest.fn() },
}));
jest.mock("../../src/utlils/ai", () => ({
  ...jest.requireActual("../../src/utlils/ai"),
  generateContent: (...args: unknown[]) => mockGenerate(...args),
}));
jest.mock("../../src/utlils/content", () => ({
  ...jest.requireActual("../../src/utlils/content"),
  getClusteredTitles: async () => [],
  formatCreatorsData: () => "",
  formatGeneratedIdea: async (
    idea: Record<string, unknown>,
    owner: Record<string, unknown>,
    batchId: string,
  ) => ({
    id: "saved",
    title: idea.workingTitle,
    concept: idea.concept,
    ideaType: idea.type,
    evidence: idea.evidence,
    ...owner,
    createdBy: owner.userId,
    batchId,
    embedding: Array(3072).fill(0.123456789),
    internalSecret: "NEVER_PUBLIC",
  }),
}));
jest.mock("../../src/container", () => ({
  ideaController: new (require("../../src/controller/idea.controller").default)(
    new (require("../../src/service/content.service").default)(
      mockRepo,
      { update: async () => {} },
      { getProjectsByIdea: async () => [] },
      require("../helpers/account").fakeAccountRepo(),
      { getIdeaSignals: () => mockResearch() },
      new (require("../../src/service/step-runner").default)({
        reserve: async () => null,
        settle: (...args: unknown[]) => mockSettle(...args),
      }),
    ),
  ),
}));
const mockGenerate = jest.fn();
const mockResearch = jest.fn();
const mockSettle = jest.fn();
const mockRepo = {
  getIdeas: jest.fn(),
  batchSaveIdeas: jest.fn(),
  getIdea: jest.fn(),
  updateIdea: jest.fn(),
  getActiveBatch: jest.fn(),
  archiveUserIdeas: jest.fn(),
};
import express from "express";
import request from "supertest";
import ideas from "../../src/routes/v1/ideas.route";
import { responseFormatter } from "../../src/middleware/response_formatter";
import { errorHandler } from "../../src/middleware/error_handler";
import { useSharedServer } from "./shared-server";
import { TEST_ACCOUNT_ID } from "../helpers/account";
const app = express();
app.use(responseFormatter, express.json());
app.use("/v1/ideas", ideas);
app.use(errorHandler);
const server = useSharedServer(app);
const payload = [
  {
    workingTitle: "<img src=x onerror=alert(1)> é\n\nevent: result",
    concept: "A meaningful concept",
    type: "long",
    evidence: "Public evidence",
  },
];
const internal = {
  createdAt: { toDate: () => new Date("2026-01-01") },
  id: "old",
  title: "Old",
  concept: "Concept",
  ideaType: "long",
  accountId: TEST_ACCOUNT_ID,
  embedding: Array(3072).fill(0.123456789),
  batchId: "private",
  internalSecret: "NEVER_PUBLIC",
};
const stream = (raw: string) => ({
  stream: (async function* () {
    for (let i = 0; i < raw.length; i += 3)
      yield { text: () => raw.slice(i, i + 3) };
  })(),
});
const events = (text: string) =>
  text
    .split("\n\n")
    .filter((s) => s.startsWith("event:"))
    .map((s) => ({
      event: s.split("\n")[0].slice(7),
      data: JSON.parse(
        s
          .split("\n")
          .find((l) => l.startsWith("data:"))!
          .slice(6),
      ),
    }));
beforeEach(() => {
  mockGenerate
    .mockReset()
    .mockImplementation(async () => stream(JSON.stringify(payload)));
  mockResearch.mockReset().mockResolvedValue("signals");
  mockSettle.mockReset().mockResolvedValue(true);
  Object.values(mockRepo).forEach((f) => f.mockReset());
  mockRepo.batchSaveIdeas.mockImplementation(async (x) => x);
  mockRepo.getIdeas.mockResolvedValue([internal]);
  mockRepo.getActiveBatch.mockResolvedValue([internal]);
  mockRepo.getIdea.mockResolvedValue(internal);
  mockRepo.updateIdea.mockResolvedValue(undefined);
  mockRepo.archiveUserIdeas.mockResolvedValue(undefined);
});
const post = (path: string, sse = true) =>
  request(server())
    .post("/v1/ideas/" + path)
    .set("Authorization", "Bearer fixture")
    .set("Accept", sse ? "text/event-stream" : "application/json")
    .send({});
test.each(["generate", "regenerate-all", "old/regenerate"])(
  "%s keeps malicious provider content as data, strips internals, settles before result",
  async (path) => {
    let settled = false;
    mockSettle.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 30));
      settled = true;
      return true;
    });
    const res = await post(path);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");
    expect(settled).toBe(true);
    const all = events(res.text);
    expect(all.filter((e) => e.event === "result")).toHaveLength(1);
    expect(all.at(-1)?.event).toBe("result");
    expect(
      all.filter((e) => e.event === "progress").map((e) => e.data.stage),
    ).toEqual(
      expect.arrayContaining(["research", "generating", "checking", "saving"]),
    );
    const data = all.at(-1)!.data.data;
    const idea = Array.isArray(data) ? data[0] : data;
    expect(idea.title).toBe(payload[0].workingTitle);
    expect(idea.embedding).toBeUndefined();
    expect(idea.batchId).toBeUndefined();
    expect(res.text).not.toContain("NEVER_PUBLIC");
  },
);
test("list trims raw vectors while preserving a usable card and legacy generate JSON", async () => {
  const res = await request(server())
    .get("/v1/ideas")
    .set("Authorization", "Bearer fixture");
  expect(res.body.data.lists[0]).toMatchObject({
    id: "old",
    title: "Old",
    concept: "Concept",
    ideaType: "long",
  });
  expect(res.text).not.toMatch(/embedding|batchId|NEVER_PUBLIC/);
  console.log(
    "SYNTHETIC_CARD_BYTES",
    JSON.stringify(internal).length,
    JSON.stringify(res.body.data.lists[0]).length,
  );
  const legacy = await post("generate", false);
  expect(legacy.type).toBe("application/json");
  expect(legacy.body.success).toBe(true);
  expect(legacy.body.data[0].id).toBe("saved");
});
test.each([
  "not json",
  '{"secret":"PROVIDER_SECRET"}',
  "[]",
  '[{"workingTitle":"","concept":"bad","type":"long"}]',
])("malformed provider result fails cleanly: %s", async (raw) => {
  mockGenerate.mockImplementation(async () => stream(raw));
  const res = await post("generate");
  const all = events(res.text);
  expect(all.some((e) => e.event === "result")).toBe(false);
  expect(all.at(-1)?.event).toBe("generation_error");
  expect(res.text).not.toContain("PROVIDER_SECRET");
  expect(mockRepo.batchSaveIdeas).not.toHaveBeenCalled();
});
test("SSE opt-in still receives ordinary JSON auth/validation failures", async () => {
  const auth = await request(server())
    .post("/v1/ideas/generate")
    .set("Accept", "text/event-stream")
    .send({});
  expect(auth.status).toBe(401);
  expect(auth.type).toBe("application/json");
  const bad = await post("generate").send({
    context: { niche: "x".repeat(300) },
  });
  expect(bad.status).toBe(400);
  expect(bad.type).toBe("application/json");
});

test("live HTTP delivers stages while blocked and never results before persistence and settlement finish", async () => {
  let releaseResearch!: () => void,
    releaseSave!: () => void,
    releaseSettle!: () => void;
  mockResearch.mockImplementation(
    () =>
      new Promise<string>((r) => {
        releaseResearch = () => r("signals");
      }),
  );
  mockRepo.batchSaveIdeas.mockImplementation(
    (x) =>
      new Promise((r) => {
        releaseSave = () => r(x);
      }),
  );
  mockSettle.mockImplementation(
    () =>
      new Promise<boolean>((r) => {
        releaseSettle = () => r(true);
      }),
  );
  const address = server().address() as { port: number };
  const response = await fetch(
    `http://127.0.0.1:${address.port}/v1/ideas/generate`,
    {
      method: "POST",
      headers: {
        Authorization: "Bearer fixture",
        Accept: "text/event-stream",
        "Content-Type": "application/json",
      },
      body: "{}",
    },
  );
  const reader = response.body!.getReader();
  let received = "";
  const consume = (async () => {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      received += new TextDecoder().decode(chunk.value);
    }
  })();
  const until = async (check: () => boolean) => {
    for (let i = 0; i < 100 && !check(); i++)
      await new Promise((r) => setTimeout(r, 5));
    expect(check()).toBe(true);
  };
  try {
    await until(() => received.includes('"stage":"research"'));
    expect(received).not.toContain('"stage":"generating"');
    expect(received).not.toContain("event: result");
    releaseResearch();
    await until(() => !!releaseSave);
    await until(() => received.includes('"stage":"saving"'));
    expect(received).not.toContain("event: result");
    releaseSave();
    await until(() => !!releaseSettle);
    expect(received).not.toContain("event: result");
    releaseSettle();
    await consume;
    expect(events(received).at(-1)?.event).toBe("result");
  } finally {
    releaseResearch?.();
    releaseSave?.();
    releaseSettle?.();
    await reader.cancel();
  }
});
test("client disconnect does not repeat generation and pending saved operation still settles", async () => {
  let releaseResearch!: () => void;
  mockResearch.mockImplementation(
    () =>
      new Promise<string>((r) => {
        releaseResearch = () => r("signals");
      }),
  );
  const address = server().address() as { port: number };
  const controller = new AbortController();
  const response = await fetch(
    `http://127.0.0.1:${address.port}/v1/ideas/generate`,
    {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: "Bearer fixture",
        Accept: "text/event-stream",
        "Content-Type": "application/json",
      },
      body: "{}",
    },
  );
  const reader = response.body!.getReader();
  await reader.read();
  controller.abort();
  await reader.cancel().catch(() => {});
  releaseResearch();
  for (let i = 0; i < 100 && !mockSettle.mock.calls.length; i++)
    await new Promise((r) => setTimeout(r, 5));
  expect(mockGenerate).toHaveBeenCalledTimes(1);
  expect(mockRepo.batchSaveIdeas).toHaveBeenCalledTimes(1);
  expect(mockSettle).toHaveBeenCalledWith(null, false);
});
