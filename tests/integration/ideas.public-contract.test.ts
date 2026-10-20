/** Real idea routes, authentication/account middleware, service and repository.
 * Only token verification and external generation are stubbed; DB is the shared
 * query-evaluating fake (not a Firestore index or production latency test).
 */
jest.mock("../../src/config/firebase", () => {
  const config = require("../helpers/fake-firestore").mockFirebase();
  config.firebase.auth = () => ({ verifyIdToken: async (token: string) => {
    if (token !== "owner" && token !== "viewer" && token !== "stranger") throw new Error("invalid");
    return { uid: token };
  } });
  return config;
});
jest.mock("../../src/config/ai", () => ({ __esModule: true, default: jest.fn(), embeddingModel: { embedContent: jest.fn() } }));
jest.mock("../../src/container", () => {
  const accountRepository = new (require("../../src/repository/account.repository").default)();
  const service = new (require("../../src/service/content.service").default)(
    new (require("../../src/repository/content.repository").default)(), {}, {}, accountRepository, undefined, {},
  );
  return {
    accountRepository, accountService: {}, videoProjectRepository: {},
    ideaController: new (require("../../src/controller/idea.controller").default)(service),
    __ideaService: service,
  };
});
import express from "express";
import request from "supertest";
import ideas from "../../src/routes/v1/ideas.route";
import { responseFormatter } from "../../src/middleware/response_formatter";
import { errorHandler } from "../../src/middleware/error_handler";
import { fakeTimestamp, FakeFirestore } from "../helpers/fake-firestore";
import { useSharedServer } from "./shared-server";
const store = require("../../src/config/firebase").__db as FakeFirestore;
const service = require("../../src/container").__ideaService;
const app = express();
app.use(express.json(), responseFormatter);
app.use("/v1/ideas", ideas);
app.use(errorHandler);
const server = useSharedServer(app);
const fixture = (id: string, title = "Prefix duplicate") => ({
  id, title, accountId: "channel", createdBy: "owner", concept: "A useful concept", evidence: "A signal",
  ideaType: "long", archived: false, isScriptGenerated: false, videoProjectId: null, userFeedback: null,
  createdAt: fakeTimestamp(1000), updatedAt: fakeTimestamp(2000),
  embedding: Array(3072).fill(0.125), batchId: "private-batch", providerMetadata: { embedding: [1], secret: "private" },
});
const assertPublic = (value: unknown): void => {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    expect(["embedding", "batchId", "providerMetadata", "_sentinel", "_methodName"]).not.toContain(key);
    assertPublic(child);
  }
};
const get = (query: Record<string, unknown> = {}, token = "owner") => request(server()).get("/v1/ideas")
  .set("Authorization", `Bearer ${token}`).set("X-Account-Id", "channel").query(query);
beforeEach(() => {
  store.data.clear();
  store.seed("accounts", [{ id: "channel", memberUids: ["owner", "viewer"], members: { owner: { role: "owner" }, viewer: { role: "viewer" } } }]);
  store.seed("ideas", [fixture("a"), fixture("b"), fixture("c", "Zebra"), { ...fixture("archived"), archived: true }, { ...fixture("foreign"), accountId: "other" }]);
});
it("returns small public rows and stable default pages with equal timestamps", async () => {
  const first = await get({ limit: 2 }).expect(200);
  assertPublic(first.body);
  expect(first.body.data.lists.map((row: { id: string }) => row.id)).toEqual(["c", "b"]);
  expect(first.body.data.lists[0]).toMatchObject({ createdAt: "1970-01-01T00:00:01.000Z", updatedAt: "1970-01-01T00:00:02.000Z" });
  expect(Buffer.byteLength(JSON.stringify(first.body))).toBeLessThan(2000);
  const second = await get({ limit: 2, ...first.body.data.meta.nextCursor }).expect(200);
  expect(second.body.data.lists.map((row: { id: string }) => row.id)).toEqual(["a"]);
  expect(second.body.data.meta.hasNextPage).toBe(false);
});
it("keeps duplicate titles reachable in prefix search", async () => {
  const first = await get({ limit: 1, searchText: "Prefix" }).expect(200);
  const second = await get({ limit: 1, searchText: "Prefix", ...first.body.data.meta.nextCursor }).expect(200);
  expect([first.body.data.lists[0].id, second.body.data.lists[0].id]).toEqual(["a", "b"]);
  expect(second.body.data.meta.hasNextPage).toBe(false);
});
it("enforces authentication, channel membership and viewer mutation denial", async () => {
  await request(server()).get("/v1/ideas").expect(401);
  await get({}, "stranger").expect(403);
  await get({}, "viewer").expect(200);
  const denied = await request(server()).post("/v1/ideas/generate").set("Authorization", "Bearer viewer").set("X-Account-Id", "channel").send({}).expect(403);
  expect(denied.body.code).toBe("role_forbidden");
});
it.each([
  ["generateIdeas", "/v1/ideas/generate", true],
  ["regenerateAll", "/v1/ideas/regenerate-all", true],
  ["regenerateOne", "/v1/ideas/a/regenerate", false],
] as const)("strips storage fields from %s JSON and SSE", async (method, path, batch) => {
  const generated = { ...fixture("a"), createdAt: { _sentinel: "pending" } };
  const spy = jest.spyOn(service, method).mockResolvedValue(batch ? [generated] : generated);
  try {
    for (const accept of ["application/json", "text/event-stream"]) {
      const response = await request(server()).post(path).set("Authorization", "Bearer owner").set("X-Account-Id", "channel").set("Accept", accept).send({}).expect(200);
      const envelope = accept === "application/json" ? response.body : JSON.parse(response.text.split("data: ")[1].split("\n")[0]);
      assertPublic(envelope);
      const row = batch ? envelope.data[0] : envelope.data;
      expect(row.title).toBe("Prefix duplicate");
      expect(row.createdAt).toBeUndefined();
    }
  } finally { spy.mockRestore(); }
});

it("uses document identity when stored id is missing or stale", async () => {
  const missing = { ...fixture("a") } as Record<string, unknown>;
  delete missing.id;
  store.col("ideas").set("a", missing);
  store.col("ideas").set("b", { ...fixture("stale-id") });
  const first = await get({ limit: 1, searchText: "Prefix" }).expect(200);
  expect(first.body.data.lists[0].id).toBe("a");
  const second = await get({ limit: 1, searchText: "Prefix", ...first.body.data.meta.nextCursor }).expect(200);
  expect(second.body.data.lists[0].id).toBe("b");
});
it("keeps the search prefix lower bound when a stale cursor predates it", async () => {
  store.seed("ideas", [fixture("early", "Apple")]);
  const response = await get({ searchText: "Prefix", title: "A", docId: "old" }).expect(200);
  expect(response.body.data.lists.map((row: { title: string }) => row.title)).toEqual(["Prefix duplicate", "Prefix duplicate"]);
});
