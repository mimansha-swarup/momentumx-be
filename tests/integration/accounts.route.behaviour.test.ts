/** Account discovery, creation and bootstrap remain authenticated without a
 * channel header. The real account middleware verifies the router's ordering. */

jest.mock("firebase-admin", () => ({
  apps: [],
  initializeApp: jest.fn(),
  credential: { cert: jest.fn() },
  firestore: Object.assign(jest.fn().mockReturnValue({}), {
    FieldValue: { serverTimestamp: jest.fn().mockReturnValue({ _sentinel: "ts" }) },
    FieldPath: { documentId: jest.fn() },
  }),
  auth: jest.fn().mockReturnValue({
    verifyIdToken: (...args: unknown[]) => mockVerifyIdToken(...args),
  }),
}));

const mockVerifyIdToken = jest.fn();

jest.mock("../../src/config/firebase", () => ({
  db: {},
  auth: { verifyIdToken: (...args: unknown[]) => mockVerifyIdToken(...args) },
  firebase: {
    firestore: {
      FieldValue: { serverTimestamp: jest.fn().mockReturnValue({ _sentinel: "ts" }) },
      FieldPath: { documentId: jest.fn() },
    },
    // authMiddleware calls firebase.auth() — without it every request 500s
    // before reaching the router, and the exemption under test never runs.
    auth: jest.fn().mockReturnValue({
      verifyIdToken: (...args: unknown[]) => mockVerifyIdToken(...args),
    }),
  },
}));

const mockAccountService = {
  listAccounts: jest.fn(),
  resolveActiveAccountId: jest.fn(),
  createAccount: jest.fn(),
  bootstrapAccount: jest.fn(),
  getAccount: jest.fn(),
  updateAccount: jest.fn(),
  activateAccount: jest.fn(),
  deleteAccount: jest.fn(),
  // accountMiddleware reaches for these on the routes below the mount.
  ensureDefaultAccount: jest.fn(),
  clearActiveAccount: jest.fn(),
};

const mockAccountRepository = {
  findById: jest.fn(),
  findByMember: jest.fn(),
};

jest.mock("../../src/container", () => ({
  accountController: new (require("../../src/controller/account.controller").default)(
    mockAccountService
  ),
  accountService: mockAccountService,
  accountRepository: mockAccountRepository,
  videoProjectRepository: { findByIdUnchecked: jest.fn() },
}));

import request from "supertest";
import express from "express";
import { useSharedServer } from "./shared-server";
import { responseFormatter } from "../../src/middleware/response_formatter";
import { errorHandler } from "../../src/middleware/error_handler";
import accountRouter from "../../src/routes/v1/account.route";

const ACC = "acc-11111111-2222-4333-8444-555555555555";
const AUTH_HEADER: [string, string] = ["Authorization", "Bearer token"];

// Built ONCE and bound ONCE. This used to construct a fresh Express app on every
// call, so `request(server())` made supertest bind and tear down an ephemeral port
// per request — 14 of them in this file. That churn is the documented cause of the
// intermittent connection-level failure (a bare 501 from Node with an empty body,
// see ./shared-server.ts), and it is process-global: the victim was usually some
// OTHER suite, which is why this file never reproduced it alone.
const buildApp = () => {
  const app = express();
  app.use(express.json());
  app.use(responseFormatter);
  app.use("/v1/accounts", accountRouter);
  app.use(errorHandler);
  return app;
};

const server = useSharedServer(buildApp());

const membership = {
  id: ACC,
  memberUids: ["user-1"],
  members: { "user-1": { role: "owner" } },
  deletedAt: null,
};

beforeEach(() => {
  jest.clearAllMocks();
  mockVerifyIdToken.mockResolvedValue({ uid: "user-1" });
  mockAccountService.listAccounts.mockResolvedValue([]);
  mockAccountService.resolveActiveAccountId.mockResolvedValue(null);
  mockAccountRepository.findById.mockResolvedValue(membership);
  mockAccountRepository.findByMember.mockResolvedValue([membership]);
});

describe("the collection routes run without account context", () => {
  it("bootstraps without a channel header but still requires authentication", async () => {
    // A full multi-member roster, not `{ id: ACC }` — bootstrap can ADOPT an
    // existing membership (including one where the caller is a viewer in a
    // channel someone else owns), so it must withhold the roster exactly like
    // `GET /v1/accounts/:id` does. The old `{ id: ACC }` fixture had no roster
    // to leak, which is why a raw pass-through response went uncaught here.
    mockAccountService.bootstrapAccount.mockResolvedValue({
      id: ACC,
      displayName: "Kitchen",
      members: { "user-1": { role: "viewer" }, "someone-else": { role: "owner" } },
      memberUids: ["user-1", "someone-else"],
      ownerUids: ["someone-else"],
      billingOwnerUid: "someone-else",
    });
    const res = await request(server()).post("/v1/accounts/bootstrap").set(...AUTH_HEADER).send({});
    expect(res.status).toBe(200);
    expect(res.body.data.account.id).toBe(ACC);
    for (const leaked of ["members", "memberUids", "ownerUids", "billingOwnerUid"]) {
      expect(res.body.data.account[leaked]).toBeUndefined();
    }
    expect(JSON.stringify(res.body)).not.toContain("someone-else");
    expect(res.body.data.account).toMatchObject({
      role: "viewer",
      isBillingOwner: false,
      memberCount: 2,
    });
    expect(mockAccountService.bootstrapAccount).toHaveBeenCalledWith("user-1");
    expect((await request(server()).post("/v1/accounts/bootstrap").send({})).status).toBe(401);
  });

  it("GET /v1/accounts works with no X-Account-Id header", async () => {
    mockAccountService.listAccounts.mockResolvedValue([{ id: ACC, name: "A" }]);
    mockAccountService.resolveActiveAccountId.mockResolvedValue(ACC);

    const res = await request(server()).get("/v1/accounts").set(...AUTH_HEADER);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ accounts: [{ id: ACC, name: "A" }], activeAccountId: ACC });
  });

  it("POST /v1/accounts works with no X-Account-Id header, and takes no body", async () => {
    // `create` is now projected the same way as `getById`/`bootstrap` — a
    // consistency fix, not a leak fix, since the caller is this channel's sole
    // member. That still changes the response shape: `role`/`isBillingOwner`/
    // `memberCount` are added and the raw roster fields are dropped, which is a
    // visible frontend contract change.
    mockAccountService.createAccount.mockResolvedValue({
      id: "acc-new",
      displayName: "Untitled channel",
      members: { "user-1": { role: "owner" } },
      memberUids: ["user-1"],
      ownerUids: ["user-1"],
      billingOwnerUid: "user-1",
    });

    const res = await request(server()).post("/v1/accounts").set(...AUTH_HEADER).send({});

    expect(res.status).toBe(201);
    expect(res.body.data.account).toEqual({
      id: "acc-new",
      displayName: "Untitled channel",
      role: "owner",
      isBillingOwner: true,
      memberCount: 1,
    });
    // The uid comes from the token; nothing else is read.
    expect(mockAccountService.createAccount).toHaveBeenCalledWith("user-1");
  });

  it("neither of them mints a channel as a side effect of being called", async () => {
    // `ensureDefaultAccount` belongs to accountMiddleware's fallback. Reaching it
    // from here would mean the exemption is gone and these two are running with
    // the middleware in front of them after all.
    await request(server()).get("/v1/accounts").set(...AUTH_HEADER);
    await request(server()).post("/v1/accounts").set(...AUTH_HEADER).send({});

    expect(mockAccountService.ensureDefaultAccount).not.toHaveBeenCalled();
  });

  it("but they are still authenticated — no token, no list", async () => {
    // The exemption is from the ACCOUNT half only. If it ever reaches auth, every
    // user's channel list is public.
    const res = await request(server()).get("/v1/accounts");

    expect(res.status).toBe(401);
  });
});

describe("everything addressed by :id keeps account context", () => {
  it("GET /v1/accounts/:id resolves membership through the middleware", async () => {
    mockAccountService.getAccount.mockResolvedValue({ id: ACC });

    const res = await request(server())
      .get(`/v1/accounts/${ACC}`)
      .set(...AUTH_HEADER)
      .set("X-Account-Id", ACC);

    expect(res.status).toBe(200);
    expect(mockAccountRepository.findById).toHaveBeenCalledWith(ACC);
  });

  it("403s on a channel the caller is not a member of, before the controller runs", async () => {
    mockAccountRepository.findById.mockResolvedValue({
      ...membership,
      memberUids: ["someone-else"],
    });

    const res = await request(server())
      .get(`/v1/accounts/${ACC}`)
      .set(...AUTH_HEADER)
      .set("X-Account-Id", ACC);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("account_forbidden");
    expect(mockAccountService.getAccount).not.toHaveBeenCalled();
  });

  it("does not hand the membership roster to a member", async () => {
    // `GET /:id/members` is owner-only AND re-checks ownership in its transaction.
    // Shipping the stored document here gave every member — viewers included —
    // each member's uid and role plus the payer's uid, so the owner gate withheld
    // only the display names that endpoint adds on top.
    mockAccountService.getAccount.mockResolvedValue({
      id: ACC,
      displayName: "Kitchen",
      handle: "@kitchen",
      members: { "user-1": { role: "viewer" }, "someone-else": { role: "owner" } },
      memberUids: ["user-1", "someone-else"],
      ownerUids: ["someone-else"],
      billingOwnerUid: "someone-else",
    });

    const res = await request(server())
      .get(`/v1/accounts/${ACC}`)
      .set(...AUTH_HEADER)
      .set("X-Account-Id", ACC);

    expect(res.status).toBe(200);
    for (const leaked of ["members", "memberUids", "ownerUids", "billingOwnerUid"]) {
      expect(res.body.data.account[leaked]).toBeUndefined();
    }
    expect(JSON.stringify(res.body)).not.toContain("someone-else");
    // What the settings screen actually needs still arrives.
    expect(res.body.data.account).toMatchObject({
      displayName: "Kitchen",
      role: "viewer",
      isBillingOwner: false,
      memberCount: 2,
    });
  });

  it("answers wrong_account — not role_forbidden — when :id is not the active channel", async () => {
    // `requireRole` reads `req.role`, which the middleware resolved from the
    // HEADER's channel, while these routes act on `params.id`. Unpinned, someone
    // who owns B but is a viewer in the active channel A got `role_forbidden` for
    // `PATCH /accounts/B` — and that code means "inline message, stay put", so the
    // client never offered the switch that would have made the call work.
    mockAccountService.getAccount.mockResolvedValue({ id: "other-channel", displayName: "Travel" });

    const res = await request(server())
      .patch(`/v1/accounts/other-channel`)
      .set(...AUTH_HEADER)
      .set("X-Account-Id", ACC)
      .send({ displayName: "New" });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("wrong_account");
    expect(res.body.detail).toMatchObject({ accountId: "other-channel", displayName: "Travel" });
    expect(mockAccountService.updateAccount).not.toHaveBeenCalled();
  });

  it("POST /:id/activate answers 204 with no body", async () => {
    const res = await request(server())
      .post(`/v1/accounts/${ACC}/activate`)
      .set(...AUTH_HEADER)
      .set("X-Account-Id", ACC);

    expect(res.status).toBe(204);
    expect(mockAccountService.activateAccount).toHaveBeenCalledWith("user-1", ACC);
  });

  it("PATCH and DELETE reach the service with the token's uid", async () => {
    mockAccountService.updateAccount.mockResolvedValue({ id: ACC, displayName: "New" });

    await request(server())
      .patch(`/v1/accounts/${ACC}`)
      .set(...AUTH_HEADER)
      .set("X-Account-Id", ACC)
      .send({ displayName: "New" });
    await request(server())
      .delete(`/v1/accounts/${ACC}`)
      .set(...AUTH_HEADER)
      .set("X-Account-Id", ACC);

    expect(mockAccountService.updateAccount).toHaveBeenCalledWith("user-1", ACC, {
      displayName: "New",
    });
    expect(mockAccountService.deleteAccount).toHaveBeenCalledWith("user-1", ACC);
  });
});
