let claims: any;
import { Timestamp } from "firebase-admin/firestore";
const store = new Map<string, any>();
const versions = new Map<string, number>();
const SENTINEL = Symbol("serverTimestamp");
const clone = (v: any): any => v instanceof Timestamp ? v : Array.isArray(v) ? v.map(clone) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clone(x)])) : v;
const snapshot = (key: string) => ({ id: key.split("/").pop(), exists: store.has(key), data: () => clone(store.get(key)) });
const ref = (key: string): any => ({ key, get: async () => snapshot(key), collection: (name: string) => query(`${key}/${name}`) });
const resolve = (v: any): any => v === SENTINEL ? Timestamp.now() : v instanceof Timestamp ? v : Array.isArray(v) ? v.map(resolve) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, resolve(x)])) : v;
const put = (key: string, value: any) => { store.set(key, resolve(clone(value))); versions.set(key, (versions.get(key) || 0) + 1); };
let retries = 0;
const runTransaction = async (callback: any): Promise<any> => {
  for (let attempt = 0; attempt < 10; attempt++) {
    const reads = new Map<string, number>();
    const writes: (() => void)[] = [];
    const tx = {
      // A doc ref carries `key`; a query does not. The repository now revokes a
      // departing member's pending invites inside the writing transaction.
      get: async (target: any) => {
        if (!target?.key) return target.get();
        reads.set(target.key, versions.get(target.key) || 0);
        return snapshot(target.key);
      },
      update: ({ key }: any, data: any) => writes.push(() => put(key, { ...store.get(key), ...data })),
      create: ({ key }: any, data: any) => writes.push(() => { if (store.has(key)) throw Error("exists"); put(key, data); }),
      set: ({ key }: any, data: any) => writes.push(() => put(key, { ...store.get(key), ...data })),
    };
    const result = await callback(tx);
    if ([...reads].some(([key, version]) => (versions.get(key) || 0) !== version)) { retries++; continue; }
    writes.forEach(write => write());
    return result;
  }
  throw Error("retry limit");
};
// `pending`/`list` now filter `expiresAt` with ">" so the page cap applies to
// live rows, not to whatever happens to sort first among 100+ expired ones —
// so this fake has to understand a comparison, not just "==".
const matchesFilter = (data: any, field: string, op: string, value: any) => {
  const actual = data?.[field];
  const av = typeof actual?.toMillis === "function" ? actual.toMillis() : actual;
  const bv = typeof value?.toMillis === "function" ? value.toMillis() : value;
  switch (op) {
    case ">": return av > bv;
    case ">=": return av >= bv;
    case "<": return av < bv;
    case "<=": return av <= bv;
    default: return actual === value;
  }
};
const query = (name: string, filters: [string, string, any][] = [], cap = Infinity): any => ({
  doc: (id: string) => ref(`${name}/${id}`),
  where: (field: string, op: string, value: any) => query(name, [...filters, [field, op, value]], cap),
  // The invite queries are bounded now, so the fake has to answer `.limit`.
  limit: (n: number) => query(name, filters, n),
  get: async () => ({
    docs: [...store.keys()]
      .filter(key => key.startsWith(name + "/") && filters.every(([field, op, value]) => matchesFilter(store.get(key), field, op, value)))
      .slice(0, cap)
      // `.ref` so a revoke can write back to the document it found.
      .map(key => ({ ...snapshot(key), ref: ref(key) })),
  }),
});
jest.mock("../../src/config/firebase", () => ({
  db: { collection: (name: string) => query(name), runTransaction: (fn: any) => runTransaction(fn) },
  firebase: { auth: () => ({ verifyIdToken: async () => claims }), firestore: { FieldValue: { serverTimestamp: () => SENTINEL } } },
}));

const controller = new Proxy({}, { get: () => (_req: any, res: any) => res.sendSuccess({ data: "allowed" }) });
// sharing.route.ts and invite.route.ts now delegate to thin controllers rather
// than calling the repository/service directly (layer boundary fix) — built from
// the SAME repository instance and account-service stub the routes used to call
// inline, so every assertion below still exercises the real repository logic
// against the fake firestore.
const sharingRepo = new (require("../../src/repository/sharing.repository").default)();
const mockAccountService = { getAccount: async (uid: string, id: string) => { const account = store.get(`accounts/${id}`); if (!account?.memberUids?.includes(uid)) throw require("../../src/utlils/errors").AccountForbidden(); return account; }, listAccounts: async () => [{ id: "channel", role: "viewer" }] };
jest.mock("../../src/container", () => ({
  sharingRepository: sharingRepo,
  sharingController: new (require("../../src/controller/sharing.controller").default)(sharingRepo),
  inviteController: new (require("../../src/controller/invite.controller").default)(sharingRepo, mockAccountService),
  accountService: mockAccountService,
  accountRepository: { findById: async () => store.get("accounts/channel") },
  videoProjectRepository: { findByIdUnchecked: async () => ({ accountId: "channel" }) },
  ideaController: controller, scriptController: controller, researchController: controller,
  hooksController: controller, packagingController: controller, videoProjectController: controller,
}));
import express from "express";
import { useSharedServer } from "./shared-server";
import request from "supertest";
import { responseFormatter } from "../../src/middleware/response_formatter";
import { errorHandler } from "../../src/middleware/error_handler";
import invites from "../../src/routes/v1/invite.route";
import sharing from "../../src/routes/v1/sharing.route";
import ideas from "../../src/routes/v1/ideas.route";
import scripts from "../../src/routes/v1/scripts.route";
import research from "../../src/routes/v1/research.route";
import hooks from "../../src/routes/v1/hooks.route";
import packaging from "../../src/routes/v1/packaging.route";
import projects from "../../src/routes/v1/video-project.route";
const app = express();
app.use(express.json()); app.use(responseFormatter);
app.use("/v1/invites", invites); app.use("/v1/accounts", sharing);
app.use("/v1/ideas", ideas); app.use("/v1/scripts", scripts); app.use("/v1/research", research);
app.use("/v1/hooks", hooks); app.use("/v1/packaging", packaging); app.use("/v1/video-projects", projects);
app.use(errorHandler);
const server = useSharedServer(app);
const token = "a".repeat(43);
beforeEach(() => {
  store.clear(); versions.clear(); claims = { uid: "viewer", email: "guest@example.com", email_verified: true };
  put("accounts/channel", { id: "channel", displayName: "Kitchen", deletedAt: null, billingOwnerUid: "owner", memberUids: ["owner", "viewer"], ownerUids: ["owner"], members: { owner: { role: "owner" }, viewer: { role: "viewer" } } });
  put(`invites/${token}`, { accountId: "channel", email: "guest@example.com", role: "viewer", status: "pending", expiresAt: Timestamp.fromMillis(Date.now()+60000), accountName: "Kitchen", invitedByName: "Chef" });
});
it("public preview masks email; acceptance requires authentication but no account header", async () => {
  const preview = await request(server()).get(`/v1/invites/${token}`).expect(200);
  expect(preview.body.data.emailMasked).toBe("g••••@example.com");
  expect(preview.body.data.email).toBeUndefined();
  await request(server()).post(`/v1/invites/${token}/accept`).expect(401);
  const joined = await request(server()).post(`/v1/invites/${token}/accept`).set("Authorization", "Bearer good").expect(200);
  expect(joined.body.data.account.id).toBe("channel");
  const replay = await request(server()).post(`/v1/invites/${token}/accept`).set("Authorization", "Bearer good").expect(403);
  expect(replay.body.code).toBe("invite_used");
});
it.each([["wrong@example.com", true, "invite_email_mismatch"], ["guest@example.com", false, "invite_email_unverified"]])("acceptance uses verified token claims (%s)", async (email, verified, code) => {
  claims.email = email; claims.email_verified = verified;
  const response = await request(server()).post(`/v1/invites/${token}/accept`).set("Authorization", "Bearer good").send({ email: "guest@example.com", email_verified: true }).expect(403);
  expect(response.body.code).toBe(code);
});
it("expired links report their terminal state and refuse acceptance", async () => {
  store.get(`invites/${token}`).expiresAt = Timestamp.fromMillis(0);
  const preview = await request(server()).get(`/v1/invites/${token}`).expect(200);
  expect(preview.body.data.status).toBe("expired");
  const result = await request(server()).post(`/v1/invites/${token}/accept`).set("Authorization", "Bearer good").expect(403);
  expect(result.body.code).toBe("invite_expired");
});
it.each([
  ["post", "/ideas/generate"], ["post", "/ideas/regenerate-all"], ["patch", "/ideas/edit/id"], ["post", "/ideas/id/regenerate"],
  ["patch", "/scripts/edit/id"], ["post", "/scripts/id/regenerate"],
  ["post", "/hooks/generate"], ["post", "/hooks/id/select"], ["post", "/hooks/id/regenerate"],
  ["post", "/packaging/generate-title"], ["post", "/packaging/generate-description"], ["post", "/packaging/generate-thumbnail"], ["post", "/packaging/generate-shorts"], ["post", "/packaging/save"], ["post", "/packaging/id/regenerate/title"], ["post", "/packaging/id/select-title"],
  ["post", "/video-projects"], ["patch", "/video-projects/id"], ["delete", "/video-projects/id"], ["patch", "/video-projects/id/step/script/complete"], ["patch", "/video-projects/id/link/script"],
  ["get", "/research/trending"], ["get", "/research/competitors"], ["get", "/research/keywords"],
  ["post", "/accounts/channel/invites"], ["patch", "/accounts/channel/members/owner"], ["delete", "/accounts/channel/members/owner"], ["post", "/accounts/channel/transfer-ownership"],
])("viewer forbidden by real router %s %s", async (method, path) => {
  const result = await (request(server()) as any)[method]("/v1"+path).set("Authorization", "Bearer good").set("X-Account-Id", "channel").expect(403);
  expect(result.body.code).toBe("role_forbidden");
});
it("the GET stream also rejects viewers before generating", async () => {
  const result = await request(server()).get("/v1/scripts/stream/project?token=good").expect(403);
  expect(result.body.code).toBe("role_forbidden");
});
it.each(["/ideas/export", "/scripts/id/export", "/hooks/id/export", "/packaging/id/export"])("viewer can export %s", async path => {
  await request(server()).get("/v1"+path).set("Authorization", "Bearer good").set("X-Account-Id", "channel").expect(200);
});
it("editor can generate but cannot manage members", async () => {
  store.get("accounts/channel").members.viewer.role = "editor";
  await request(server()).post("/v1/ideas/regenerate-all").set("Authorization", "Bearer good").set("X-Account-Id", "channel").expect(200);
  await request(server()).get("/v1/accounts/channel/members").set("Authorization", "Bearer good").set("X-Account-Id", "channel").expect(403);
});
it("pending inbox scopes to verified token email and omits expired invitations", async () => {
  put(`invites/${"b".repeat(43)}`, { ...store.get(`invites/${token}`), email: "someone@example.com" });
  put(`invites/${"c".repeat(43)}`, { ...store.get(`invites/${token}`), expiresAt: Timestamp.fromMillis(0) });
  const result = await request(server()).get("/v1/invites").set("Authorization", "Bearer good").expect(200);
  expect(result.body.data.invites.map((invite: any) => invite.token)).toEqual([token]);
  claims.email_verified = false;
  const unverified = await request(server()).get("/v1/invites").set("Authorization", "Bearer good").expect(403);
  expect(unverified.body.code).toBe("invite_email_unverified");
});
it("owners can manage members/invites and transfer payer; a viewer can leave", async () => {
  claims.uid = "owner";
  const members = await request(server()).get("/v1/accounts/channel/members").set("Authorization", "Bearer good").set("X-Account-Id", "channel").expect(200);
  expect(members.body.data.members.map((member: any) => member.uid)).toEqual(["owner", "viewer"]);
  await request(server()).patch("/v1/accounts/channel/members/viewer").set("Authorization", "Bearer good").set("X-Account-Id", "channel").send({ role: "editor" }).expect(200);
  await request(server()).post("/v1/accounts/channel/transfer-ownership").set("Authorization", "Bearer good").set("X-Account-Id", "channel").send({ userId: "viewer" }).expect(200);
  expect(store.get("accounts/channel").billingOwnerUid).toBe("viewer");
  await request(server()).post("/v1/accounts/channel/leave").set("Authorization", "Bearer good").set("X-Account-Id", "channel").expect(200);
  expect(store.get("accounts/channel").memberUids).toEqual(["viewer"]);
  claims.uid = "viewer";
  await request(server()).post("/v1/accounts/channel/leave").set("Authorization", "Bearer good").set("X-Account-Id", "channel").expect(400);
});
it("rejects mismatched path/header and owner body validation; revocation is effective", async () => {
  claims.uid = "owner";
  await request(server()).post("/v1/accounts/other/invites").set("Authorization", "Bearer good").set("X-Account-Id", "channel").send({ email: "guest@example.com", role: "viewer" }).expect(403);
  await request(server()).post("/v1/accounts/channel/invites").set("Authorization", "Bearer good").set("X-Account-Id", "channel").send({ email: "guest@example.com", role: "owner" }).expect(400);
  await request(server()).delete(`/v1/accounts/channel/invites/${token}`).set("Authorization", "Bearer good").set("X-Account-Id", "channel").expect(200);
  const result = await request(server()).post(`/v1/invites/${token}/accept`).set("Authorization", "Bearer good").expect(403);
  expect(result.body.code).toBe("invite_revoked");
});

it("wrong-account response names only a channel the caller can actually enter", async () => {
  claims.uid = "owner";
  put("accounts/other", { ...store.get("accounts/channel"), id: "other", displayName: "Other Kitchen" });
  const result = await request(server()).get("/v1/accounts/other/members").set("Authorization", "Bearer good").set("X-Account-Id", "channel").expect(403);
  expect(result.body.code).toBe("wrong_account");
  expect(result.body.detail).toEqual({ accountId: "other", displayName: "Other Kitchen" });
  store.get("accounts/other").memberUids = ["stranger"];
  const denied = await request(server()).get("/v1/accounts/other/members").set("Authorization", "Bearer good").set("X-Account-Id", "channel").expect(403);
  expect(denied.body.code).toBe("account_forbidden");
  expect(denied.body.detail).toBeUndefined();
});
