/** Real HTTP routing, middleware, controllers and repositories against a local DB.
 * Only identity verification is stubbed. The emulator does not enforce indexes;
 * scripts/inventory-indexes.ts --check is the separate live readiness check.
 */
let mockClaims = { uid: "owner", email: "guest@example.com", email_verified: true };
jest.mock("../../src/config/firebase", () => {
  if (process.env.FIRESTORE_EMULATOR_HOST && process.env.FIRESTORE_EMULATOR_HOST !== "127.0.0.1:18089")
    throw new Error("Invite checks require the dedicated loopback emulator");
  const { Firestore, FieldValue } = require("firebase-admin/firestore");
  return {
    db: new Firestore({ projectId: "demo-momentum-review", host: "127.0.0.1:18089", ssl: false }),
    firebase: { firestore: { FieldValue }, auth: () => ({ verifyIdToken: async () => mockClaims }) },
  };
});
jest.mock("../../src/container", () => {
  const accountRepository = new (require("../../src/repository/account.repository").default)();
  const videoProjectRepository = new (require("../../src/repository/video-project.repository").default)();
  const accountService = new (require("../../src/service/account.service").default)(
    accountRepository, new (require("../../src/repository/user.repository").default)(), videoProjectRepository,
  );
  const sharingRepository = new (require("../../src/repository/sharing.repository").default)();
  return {
    accountRepository, accountService, videoProjectRepository,
    sharingController: new (require("../../src/controller/sharing.controller").default)(sharingRepository),
    inviteController: new (require("../../src/controller/invite.controller").default)(sharingRepository, accountService),
  };
});
import express from "express";
import request from "supertest";
import { Timestamp, Query } from "firebase-admin/firestore";
import { db } from "../../src/config/firebase";
import invites from "../../src/routes/v1/invite.route";
import sharing from "../../src/routes/v1/sharing.route";
import { responseFormatter } from "../../src/middleware/response_formatter";
import { errorHandler } from "../../src/middleware/error_handler";
import { useSharedServer } from "../integration/shared-server";

const local = process.env.FIRESTORE_EMULATOR_HOST === "127.0.0.1:18089" ? describe : describe.skip;
local("invite HTTP flow with real Firestore emulator", () => {
  jest.setTimeout(30000);
  const app = express();
  app.use(express.json(), responseFormatter);
  app.use("/v1/invites", invites);
  app.use("/v1/accounts", sharing);
  app.use(errorHandler);
  const server = useSharedServer(app);
  const get = (path: string) => request(server()).get(path).set("Authorization", "Bearer synthetic").set("X-Account-Id", "channel");
  const account = { displayName: "Channel", memberUids: ["owner", "viewer"], ownerUids: ["owner"], members: { owner: { role: "owner" }, viewer: { role: "viewer" } }, billingOwnerUid: "owner" };
  const invite = { accountId: "channel", accountName: "Channel", invitedByName: "Owner", email: "guest@example.com", role: "viewer", status: "pending", expiresAt: Timestamp.fromMillis(Date.now() + 3600000) };
  beforeEach(async () => {
    const reset = await fetch("http://127.0.0.1:18089/emulator/v1/projects/demo-momentum-review/databases/(default)/documents", { method: "DELETE" });
    if (!reset.ok) throw new Error("Could not reset isolated emulator");
    mockClaims = { uid: "owner", email: "guest@example.com", email_verified: true };
    await db.collection("accounts").doc("channel").set(account);
    await db.collection("accounts").doc("other").set(account);
    await db.collection("accounts").doc("deleted").set({ ...account, deletedAt: Timestamp.now() });
    const rows = {
      live: invite,
      expired: { ...invite, expiresAt: Timestamp.fromMillis(0) },
      revoked: { ...invite, status: "revoked" },
      anotherEmail: { ...invite, email: "other@example.com" },
      anotherChannel: { ...invite, accountId: "other" },
      deleted: { ...invite, accountId: "deleted" },
    };
    await Promise.all(Object.entries(rows).map(([id, row]) => db.collection("invites").doc(id).set(row)));
  });
  afterAll(async () => { await db.terminate(); });

  it.each(["/v1/invites", "/v1/accounts/channel/invites"])("requires authentication: %s", async path => {
    await request(server()).get(path).expect(401);
  });
  it("inbox filters verified token email, expiry, status and deleted channels", async () => {
    mockClaims.email = "GUEST@example.com";
    const response = await get("/v1/invites").expect(200);
    expect(response.body.data.invites.map((row: { token: string }) => row.token).sort()).toEqual(["anotherChannel", "live"]);
  });
  it("owner list filters account, status and expiry", async () => {
    const response = await get("/v1/accounts/channel/invites").expect(200);
    expect(response.body.data.invites.map((row: { token: string }) => row.token).sort()).toEqual(["anotherEmail", "live"]);
  });
  it("unverified identity is refused instead of returning an empty inbox", async () => {
    mockClaims.email_verified = false;
    const response = await get("/v1/invites").expect(403);
    expect(response.body.code).toBe("invite_email_unverified");
  });
  it("viewer cannot list all channel invitations", async () => {
    mockClaims.uid = "viewer";
    const response = await get("/v1/accounts/channel/invites").expect(403);
    expect(response.body.code).toBe("role_forbidden");
  });
  it("nonmember cannot list channel invitations", async () => {
    mockClaims.uid = "stranger";
    const response = await get("/v1/accounts/channel/invites").expect(403);
    expect(response.body.code).toBe("account_forbidden");
  });
  it.each(["/v1/invites", "/v1/accounts/channel/invites"])("query failure stays a safe 500, never a false empty success: %s", async path => {
    // Inject only the driver's failure; the emulator cannot itself reject an absent index.
    const query = jest.spyOn(Query.prototype, "get").mockRejectedValueOnce(Object.assign(new Error("9 FAILED_PRECONDITION: private index URL"), { code: 9 }));
    const log = jest.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await get(path).expect(500);
      expect(response.body.message).toBe("Something went wrong");
      expect(response.body.data?.invites).toBeUndefined();
      expect(JSON.stringify(response.body)).not.toContain("private index URL");
    } finally { query.mockRestore(); log.mockRestore(); }
  });
});
