/**
 * /v1/accounts — and specifically the exemption.
 *
 * `GET /v1/accounts` and `POST /v1/accounts` are the only two routes in the API
 * that run without account context, so the assertion that carries this file is
 * that they work with NO `X-Account-Id` header at all. Lose that and a brand-new
 * user cannot reach their own channel list — the request falls into Phase 05's
 * header-less fallback, which mints a channel as a side effect of reading, and
 * once Phase 07 makes that fallback read-only it rejects the one call whose whole
 * purpose is producing the id the header needs.
 *
 * The REAL account middleware runs here, unmocked, because the exemption is a
 * property of the router's mount order — stubbing it out would test nothing.
 */

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
import { responseFormatter } from "../../src/middleware/response_formatter";
import { errorHandler } from "../../src/middleware/error_handler";
import accountRouter from "../../src/routes/v1/account.route";

const ACC = "acc-11111111-2222-4333-8444-555555555555";
const AUTH_HEADER: [string, string] = ["Authorization", "Bearer token"];

const server = () => {
  const app = express();
  app.use(express.json());
  app.use(responseFormatter);
  app.use("/v1/accounts", accountRouter);
  app.use(errorHandler);
  return app;
};

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
  it("GET /v1/accounts works with no X-Account-Id header", async () => {
    mockAccountService.listAccounts.mockResolvedValue([{ id: ACC, name: "A" }]);
    mockAccountService.resolveActiveAccountId.mockResolvedValue(ACC);

    const res = await request(server()).get("/v1/accounts").set(...AUTH_HEADER);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ accounts: [{ id: ACC, name: "A" }], activeAccountId: ACC });
  });

  it("POST /v1/accounts works with no X-Account-Id header, and takes no body", async () => {
    mockAccountService.createAccount.mockResolvedValue({ id: "acc-new" });

    const res = await request(server()).post("/v1/accounts").set(...AUTH_HEADER).send({});

    expect(res.status).toBe(201);
    expect(res.body.data.account).toEqual({ id: "acc-new" });
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
