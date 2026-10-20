/**
 * `GET /v1/billing` — the handler function had ZERO coverage: the file read
 * 91.66% because its module body (router, mounts) is executed by every import,
 * while the one thing it does was never invoked.
 *
 * It is a four-line handler, and all four contracts are about who it answers for.
 * The balance it returns is the channel's credit allowance and spend, so "whose
 * balance" is a tenancy decision, and the route is the only place `ownerOf(req)`
 * is composed for it.
 */

jest.mock("firebase-admin", () => ({
  apps: [],
  initializeApp: jest.fn(),
  credential: { cert: jest.fn() },
  firestore: Object.assign(jest.fn().mockReturnValue({}), {
    FieldValue: { serverTimestamp: jest.fn() },
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
      FieldValue: { serverTimestamp: jest.fn() },
      FieldPath: { documentId: jest.fn() },
    },
    auth: jest.fn().mockReturnValue({
      verifyIdToken: (...args: unknown[]) => mockVerifyIdToken(...args),
    }),
  },
}));

const getBalance = jest.fn();
const findById = jest.fn();
const findByMember = jest.fn();
const resolveActiveAccountId = jest.fn();

jest.mock("../../src/container", () => ({
  billingRepository: { getBalance: (...a: unknown[]) => getBalance(...a) },
  // The route now delegates to a thin BillingController rather than calling the
  // repository directly (layer boundary fix) — built from the same stubbed
  // repository method above so every test's `getBalance` expectations still hold.
  billingController: new (require("../../src/controller/billing.controller").default)({
    getBalance: (...a: unknown[]) => getBalance(...a),
  }),
  // The REAL account middleware runs here — the whole point is that this handler
  // sits below it — so its collaborators are what get stubbed.
  accountRepository: {
    findById: (...a: unknown[]) => findById(...a),
    findByMember: (...a: unknown[]) => findByMember(...a),
  },
  accountService: {
    resolveActiveAccountId: (...a: unknown[]) => resolveActiveAccountId(...a),
    ensureDefaultAccount: jest.fn(),
    clearActiveAccount: jest.fn(),
  },
  videoProjectRepository: { findByIdUnchecked: jest.fn() },
}));

import express from "express";
import request from "supertest";
import { responseFormatter } from "../../src/middleware/response_formatter";
import { errorHandler } from "../../src/middleware/error_handler";
import billingRouter from "../../src/routes/v1/billing.route";
import { useSharedServer } from "./shared-server";
import { ServiceUnavailable } from "../../src/utlils/errors";

const app = express();
app.use(express.json());
app.use(responseFormatter);
app.use("/v1/billing", billingRouter);
app.use(errorHandler);
const server = useSharedServer(app);

const MINE = "acc-b1111111-2222-4333-8444-555555555555";
const THEIRS = "acc-b9999999-8888-4777-8666-555555555555";
const AUTH: [string, string] = ["Authorization", "Bearer valid-token"];

const account = (id: string, memberUids = ["uid-me"]) => ({
  id,
  memberUids,
  members: { "uid-me": { role: "owner" } },
  deletedAt: null,
  displayName: "My Channel",
});

const BALANCE = {
  enabled: true,
  allowance: 50,
  allowanceSource: "default",
  consumed: 12,
  periodStart: "2026-09",
  remaining: 38,
  resetsAt: "2026-10-01T00:00:00.000Z",
  costs: { ideas: 3, script: 5 },
};

beforeEach(() => {
  mockVerifyIdToken.mockReset().mockResolvedValue({ uid: "uid-me" });
  getBalance.mockReset().mockResolvedValue(BALANCE);
  findById.mockReset().mockImplementation(async (id: string) => account(id));
  findByMember.mockReset().mockResolvedValue([account(MINE)]);
  resolveActiveAccountId.mockReset().mockResolvedValue(MINE);
});

// Harm prevented: the credits screen renders "NaN of undefined" because the
// handler answered in a shape the client does not read.
it("answers with the standard success envelope and the channel's balance", async () => {
  const res = await request(server()).get("/v1/billing").set(...AUTH).set("X-Account-Id", MINE);

  expect(res.status).toBe(200);
  // `warning: ""` is added to every success body by response_formatter, so the
  // envelope is matched rather than equalled; `data` itself is exact.
  expect(res.body).toMatchObject({ success: true, message: "Credit balance" });
  expect(res.body.data).toEqual(BALANCE);
});

// Harm prevented: one user reading another channel's allowance and spend by
// editing a query string — the identity and the channel must come only from the
// verified token and the membership-checked header.
it("reads the balance for the middleware's owner, never one named by the client", async () => {
  const res = await request(server())
    .get(`/v1/billing?accountId=${THEIRS}&userId=uid-someone-else`)
    .set(...AUTH)
    .set("X-Account-Id", MINE);

  expect(res.status).toBe(200);
  expect(getBalance).toHaveBeenCalledTimes(1);
  expect(getBalance).toHaveBeenCalledWith({ userId: "uid-me", accountId: MINE });
});

it("403s account_forbidden for a channel the caller is not a member of", async () => {
  findById.mockResolvedValue(account(THEIRS, ["uid-someone-else"]));

  const res = await request(server()).get("/v1/billing").set(...AUTH).set("X-Account-Id", THEIRS);

  expect(res.status).toBe(403);
  expect(res.body).toMatchObject({ success: false, code: "account_forbidden" });
  expect(getBalance).not.toHaveBeenCalled();
});

// A balance is a read, and Phase 07 keeps the header-less fallback read-only
// precisely so a cold tab can still be shown the channel it last activated.
it("still answers a header-less read through the last-active fallback", async () => {
  const res = await request(server()).get("/v1/billing").set(...AUTH);

  expect(res.status).toBe(200);
  expect(getBalance).toHaveBeenCalledWith({ userId: "uid-me", accountId: MINE });
});

describe("authentication", () => {
  it("401s with no Authorization header", async () => {
    const res = await request(server()).get("/v1/billing");

    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ success: false });
    expect(getBalance).not.toHaveBeenCalled();
  });

  it("401s on an invalid token", async () => {
    mockVerifyIdToken.mockRejectedValue(new Error("bad token"));

    const res = await request(server()).get("/v1/billing").set("Authorization", "Bearer nope");

    expect(res.status).toBe(401);
    expect(getBalance).not.toHaveBeenCalled();
  });
});

/**
 * Harm prevented: the request hangs forever.
 *
 * `getBalance` throws for real — a cleared/misconfigured `MONTHLY_CREDIT_ALLOWANCE`
 * is a 503 from `freshBalance`, and that is the exact case an operator hits while
 * repairing a quota. Without `asyncHandler`, the rejected promise never reaches
 * Express 4's error handler and the client waits on a response that never comes.
 */
it("forwards a repository failure to the error handler with its status intact", async () => {
  getBalance.mockRejectedValue(
    ServiceUnavailable("Monthly credit allowance is not configured")
  );

  // The deadline is the assertion: without `asyncHandler` this request never
  // answers, and a test that waits forever reports nothing. 2s fails it instead.
  const res = await request(server())
    .get("/v1/billing")
    .set(...AUTH)
    .set("X-Account-Id", MINE)
    .timeout({ deadline: 2000 });

  expect(res.status).toBe(503);
  expect(res.body).toMatchObject({
    success: false,
    message: "Monthly credit allowance is not configured",
  });
});

// An unexpected throw must not leak internals (api-design.md: `code` and `detail`
// are forwarded only for 4xx HttpErrors).
it("does not leak internals from an unexpected throw", async () => {
  getBalance.mockRejectedValue(new Error("firestore: 10.0.0.7 deadline exceeded"));

  const res = await request(server()).get("/v1/billing").set(...AUTH).set("X-Account-Id", MINE);

  expect(res.status).toBe(500);
  expect(JSON.stringify(res.body)).not.toMatch(/10\.0\.0\.7/);
});
