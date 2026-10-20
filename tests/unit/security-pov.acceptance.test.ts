/** Public account/sharing contracts exercised over HTTP with real application layers.
 * Only Firebase authentication and storage are local test doubles. These checks
 * assert serial behavior; they do not claim to model Firestore contention. */
import express from "express";
import request from "supertest";
import { Timestamp } from "firebase-admin/firestore";
import { FakeFirestore } from "../helpers/fake-firestore";
import { useSharedServer } from "../integration/shared-server";

const identities: Record<string, { uid: string; email: string; email_verified: boolean }> = {
  owner: { uid: "owner", email: "owner@example.com", email_verified: true },
  viewer: { uid: "viewer", email: "viewer@example.com", email_verified: true },
  editor: { uid: "editor", email: "editor@example.com", email_verified: true },
  guest: { uid: "guest", email: "guest@example.com", email_verified: true },
  named: { uid: "constructor", email: "named@example.com", email_verified: true },
};
jest.mock(require.resolve("firebase-functions/v2/identity", { paths: [__dirname + "/../../functions"] }), () => ({
  IS_NOT_TENANT: "__no_tenant__",
  onUserCreated: (_options: unknown, handler: unknown) => handler,
  onUserDeleted: (_options: unknown, handler: unknown) => handler,
}));
jest.mock(require.resolve("firebase-admin", { paths: [__dirname + "/../../functions"] }), () => ({
  initializeApp: jest.fn(),
  firestore: Object.assign(() => require("../../src/config/firebase").db, {
    FieldValue: { serverTimestamp: () => ({ __fv: "serverTimestamp" }) },
  }),
}));
jest.mock("../../src/config/firebase", () => {
  const local = require("../helpers/fake-firestore").mockFirebase();
  local.firebase.auth = () => ({ verifyIdToken: async (token: string) => {
    if (!identities[token]) throw new Error("invalid test token");
    return identities[token];
  } });
  return local;
});
jest.mock("../../src/container", () => {
  const accountRepository = new (require("../../src/repository/account.repository").default)();
  const videoProjectRepository = new (require("../../src/repository/video-project.repository").default)();
  const accountService = new (require("../../src/service/account.service").default)(accountRepository,
    new (require("../../src/repository/user.repository").default)(), videoProjectRepository);
  const sharing = new (require("../../src/repository/sharing.repository").default)();
  return {
    accountRepository, videoProjectRepository, accountService,
    accountController: new (require("../../src/controller/account.controller").default)(accountService),
    sharingController: new (require("../../src/controller/sharing.controller").default)(sharing),
    inviteController: new (require("../../src/controller/invite.controller").default)(sharing, accountService),
  };
});
import accountRouter from "../../src/routes/v1/account.route";
import sharingRouter from "../../src/routes/v1/sharing.route";
import inviteRouter from "../../src/routes/v1/invite.route";
import { responseFormatter } from "../../src/middleware/response_formatter";
import { errorHandler } from "../../src/middleware/error_handler";


import { onDeleteUserV2 } from "../../functions/src/index";

const db: FakeFirestore = require("../../src/config/firebase").__db;
const app = express();
app.use(express.json(), responseFormatter);
app.use("/v1/accounts", accountRouter, sharingRouter);
app.use("/v1/invites", inviteRouter);
app.use(errorHandler);
const server = useSharedServer(app);
const token = "s".repeat(43);
const channel = (id: string) => ({
  id, displayName: "Private kitchen " + id, handle: null,
  memberUids: ["owner", "viewer", "editor"], ownerUids: ["owner"], billingOwnerUid: "owner",
  members: { owner: { role: "owner" }, viewer: { role: "viewer" }, editor: { role: "editor" } },
  deletedAt: null,
});

const headers = (who: string, id = "channel-a") => ({ Authorization: `Bearer ${who}`, "X-Account-Id": id });
const invitation = (id = token) => ({ id, accountId: "channel-a", email: "guest@example.com", role: "editor", status: "pending", accountName: "Private kitchen", invitedByName: "Private chef", invitedBy: "owner", createdAt: Timestamp.fromMillis(Date.now()-60000), expiresAt: Timestamp.fromMillis(Date.now()+86400000) });
beforeEach(() => {
  db.data.clear();
  identities.guest.email = "guest@example.com";
  identities.guest.email_verified = true;
  db.seed("accounts", [channel("channel-a"), { ...channel("private-b"), memberUids: ["stranger"], ownerUids: ["stranger"], members: { stranger: { role: "owner" } }, billingOwnerUid: "stranger" }]);
  db.seed("users", Object.values(identities).map(identity => ({ id: identity.uid, email: identity.email, lastActiveAccountId: "channel-a" })));
  db.seed("invites", [invitation()]);
});

it.each(["viewer", "editor"])("%s cannot borrow path-account permissions or enumerate a private channel", async who => {
  await request(server()).get("/v1/accounts/channel-a/members").set(headers(who)).expect(403);
  const denied = await request(server()).get("/v1/accounts/private-b/members").set(headers(who)).expect(403);
  expect(denied.body.detail).toBeUndefined();
  expect(JSON.stringify(denied.body)).not.toContain("stranger");
  await request(server()).patch("/v1/accounts/private-b").set(headers("owner")).send({ displayName: "Stolen" }).expect(403);
  expect(db.col("accounts").get("private-b")?.displayName).not.toBe("Stolen");
});

it("anonymous callers cannot discover memberships or mutate invitations", async () => {
  await request(server()).get("/v1/accounts").expect(401);
  await request(server()).get("/v1/accounts/channel-a/members").expect(401);
  await request(server()).post(`/v1/invites/${token}/accept`).expect(401);
  const preview = await request(server()).get(`/v1/invites/${token}`).expect(200);
  expect(JSON.stringify(preview.body)).not.toContain("guest@example.com");
});

it("bootstrap neither adopts a foreign pointer nor reveals roster to a viewer", async () => {
  db.col("users").get("guest")!.lastActiveAccountId = "private-b";
  const created = await request(server()).post("/v1/accounts/bootstrap").set(headers("guest", "private-b")).expect(200);
  expect(created.body.data.account.id).not.toBe("private-b");
  const viewer = await request(server()).post("/v1/accounts/bootstrap").set(headers("viewer")).expect(200);
  expect(viewer.body.data.account.members).toBeUndefined();
  expect(viewer.body.data.account.billingOwnerUid).toBeUndefined();
});

it.each(["deletedAt", "orphanedAt"])("%s blocks public invitation details, acceptance, and channel access", async field => {
  db.col("accounts").get("channel-a")![field] = Timestamp.now();
  const preview = await request(server()).get(`/v1/invites/${token}`);
  expect(JSON.stringify(preview.body)).not.toContain("Private chef");
  expect(JSON.stringify(preview.body)).not.toContain("Private kitchen");
  expect((await request(server()).post(`/v1/invites/${token}/accept`).set(headers("guest"))).status).toBeGreaterThanOrEqual(400);
  expect((await request(server()).get("/v1/accounts/channel-a").set(headers("viewer"))).status).toBeGreaterThanOrEqual(400);
  const inbox = await request(server()).get("/v1/invites").set(headers("guest")).expect(200);
  expect(inbox.body.data.invites).toEqual([]);
});

it.each(["viewer", "editor"])("%s account detail cannot bypass owner-only roster access", async who => {
  const response = await request(server()).get("/v1/accounts/channel-a").set(headers(who)).expect(200);
  expect(response.body.data.account.members).toBeUndefined();
  expect(response.body.data.account.memberUids).toBeUndefined();
  expect(response.body.data.account.billingOwnerUid).toBeUndefined();
});

it("demotion applies immediately and an old editor invite cannot undo it", async () => {
  await request(server()).post(`/v1/invites/${token}/accept`).set(headers("guest")).expect(200);
  const older = "d".repeat(43);
  db.seed("invites", [invitation(older)]);
  await request(server()).patch("/v1/accounts/channel-a/members/guest").set(headers("owner")).send({ role: "viewer" }).expect(200);
  await request(server()).post(`/v1/invites/${older}/accept`).set(headers("guest")).expect(403);
  const current = await request(server()).get("/v1/accounts/channel-a").set(headers("guest")).expect(200);
  expect(current.body.data.account.role).toBe("viewer");
});

it("removal invalidates an older link despite a changed profile email; a fresh invite restores access", async () => {
  const joined = await request(server()).post(`/v1/invites/${token}/accept`).set(headers("guest")).expect(200);
  expect(joined.body.data.account.id).toBe("channel-a");
  const old = "o".repeat(43);
  db.seed("invites", [invitation(old)]);
  db.col("users").get("guest")!.email = "changed@example.com";
  await request(server()).delete("/v1/accounts/channel-a/members/guest").set(headers("owner")).expect(200);
  await request(server()).post(`/v1/invites/${old}/accept`).set(headers("guest")).expect(403);
  await request(server()).get("/v1/accounts/channel-a").set(headers("guest")).expect(403);
  const fresh = await request(server()).post("/v1/accounts/channel-a/invites").set(headers("owner")).send({ email: "guest@example.com", role: "viewer" }).expect(201);
  const freshToken = fresh.body.data.invite?.token ?? fresh.body.data.token;
  expect(freshToken).toEqual(expect.any(String));
  const accepted = await request(server()).post(`/v1/invites/${freshToken}/accept`).set(headers("guest")).expect(200);
  expect(accepted.body.data.account.role).toBe("viewer");
  await request(server()).post(`/v1/invites/${freshToken}/accept`).set(headers("guest")).expect(403);
});

it("token identity, not body or profile email, controls acceptance", async () => {
  identities.guest.email = "guest+alias@example.com";
  await request(server()).post(`/v1/invites/${token}/accept`).set(headers("guest")).send({ email: "guest@example.com", email_verified: true }).expect(403);
  identities.guest.email = "guest@example.com";
  identities.guest.email_verified = false;
  await request(server()).post(`/v1/invites/${token}/accept`).set(headers("guest")).send({ email_verified: true }).expect(403);
  identities.guest.email_verified = true;
  await request(server()).post(`/v1/invites/${token}/accept`).set(headers("guest")).expect(200);
});

it("expiry and explicit revocation reject links without adding membership", async () => {
  db.col("invites").get(token)!.expiresAt = Timestamp.fromMillis(0);
  const expired = await request(server()).post(`/v1/invites/${token}/accept`).set(headers("guest")).expect(403);
  expect(expired.body.code).toBe("invite_expired");
  db.seed("invites", [invitation()]);
  await request(server()).delete(`/v1/accounts/channel-a/invites/${token}`).set(headers("owner")).expect(200);
  const revoked = await request(server()).post(`/v1/invites/${token}/accept`).set(headers("guest")).expect(403);
  expect(revoked.body.code).toBe("invite_revoked");
  expect(db.col("accounts").get("channel-a")?.memberUids).not.toContain("guest");
});

it("last owner cannot leave, demote or remove themselves through HTTP", async () => {
  await request(server()).post("/v1/accounts/channel-a/leave").set(headers("owner")).expect(400);
  await request(server()).patch("/v1/accounts/channel-a/members/owner").set(headers("owner")).send({ role: "viewer" }).expect(400);
  await request(server()).delete("/v1/accounts/channel-a/members/owner").set(headers("owner")).expect(400);
  const current = await request(server()).get("/v1/accounts/channel-a/members").set(headers("owner")).expect(200);
  expect(current.body.data.members.find((member: { uid: string }) => member.uid === "owner").role).toBe("owner");
});

it("deleting a sole owner freezes surviving memberships and closes old invitations", async () => {
  await (onDeleteUserV2 as unknown as (event: { data: { uid: string } }) => Promise<void>)({ data: { uid: "owner" } });
  await request(server()).get("/v1/accounts/channel-a").set(headers("viewer")).expect(403);
  await request(server()).post(`/v1/invites/${token}/accept`).set(headers("guest")).expect(403);
  expect(db.col("accounts").get("channel-a")?.orphanedAt).toBeDefined();
});
