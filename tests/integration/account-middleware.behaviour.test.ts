// Phase 05's trust boundary, end to end through a real Express app.
//
// Contract: docs/multi-account/phase-05-account-context-api.md.
//
// `X-Account-Id` is a client-supplied header and therefore forgeable. Every bit
// of safety here is the membership check, and the check has to be unconditional —
// so these tests are written as "what must a caller be unable to do", not as a
// walk through the middleware's branches. The failure this prevents is one person
// reading another's channel by editing a value in their browser.

import express from "express";
import request from "supertest";
import { responseFormatter } from "../../src/middleware/response_formatter";
import { errorHandler } from "../../src/middleware/error_handler";

const findById = jest.fn();
const findByMember = jest.fn();
const ensureDefaultAccount = jest.fn();
const clearActiveAccount = jest.fn().mockResolvedValue(undefined);
const findByIdUnchecked = jest.fn();

jest.mock("../../src/container", () => ({
  accountRepository: {
    findById: (...a: unknown[]) => findById(...a),
    findByMember: (...a: unknown[]) => findByMember(...a),
  },
  accountService: {
    ensureDefaultAccount: (...a: unknown[]) => ensureDefaultAccount(...a),
    clearActiveAccount: (...a: unknown[]) => clearActiveAccount(...a),
  },
  videoProjectRepository: {
    findByIdUnchecked: (...a: unknown[]) => findByIdUnchecked(...a),
  },
}));

import {
  accountMiddleware,
  fallbackRejectsWrite,
  resolveAccountFromProject,
} from "../../src/middleware/account";

const OWNED = "acc-owned-1111-4111-8111-111111111111";
const OTHER = "acc-other-2222-4222-8222-222222222222";

const account = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  memberUids: ["uid-me"],
  members: { "uid-me": { role: "owner" } },
  deletedAt: null,
  displayName: "My Channel",
  ...over,
});

/** A tiny app: fake auth → the middleware under test → echo what it set. */
const makeApp = (mw: express.RequestHandler, uid: string | undefined = "uid-me") => {
  const app = express();
  app.use(responseFormatter);
  app.use((req, _res, next) => {
    if (uid) req.userId = uid;
    next();
  });
  app.get("/probe", mw, (req, res) =>
    res.sendSuccess({ data: { accountId: req.accountId, role: req.role } })
  );
  app.post("/probe", mw, (req, res) =>
    res.sendSuccess({ data: { accountId: req.accountId, role: req.role } })
  );
  app.get("/stream/:projectId", mw, (req, res) =>
    res.sendSuccess({ data: { accountId: req.accountId, role: req.role } })
  );
  app.use(errorHandler);
  return app;
};

beforeEach(() => {
  jest.clearAllMocks();
  findById.mockResolvedValue(account(OWNED));
  findByMember.mockResolvedValue([account(OWNED)]);
  ensureDefaultAccount.mockResolvedValue(OWNED);
});

describe("a caller cannot enter a channel they are not a member of", () => {
  it("403s with account_forbidden for someone else's account id", async () => {
    findById.mockResolvedValue(account(OTHER, { memberUids: ["uid-someone-else"] }));

    const res = await request(makeApp(accountMiddleware))
      .get("/probe")
      .set("X-Account-Id", OTHER);

    expect(res.status).toBe(403);
    // The client branches on this: account_forbidden ejects to the channel list,
    // role_forbidden shows an inline message. A bare 403 cannot be told apart.
    expect(res.body.code).toBe("account_forbidden");
  });

  it("logs account_mismatch — the only signal that someone is probing ids", async () => {
    findById.mockResolvedValue(account(OTHER, { memberUids: ["uid-someone-else"] }));
    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);

    await request(makeApp(accountMiddleware)).get("/probe").set("X-Account-Id", OTHER);

    const logged = warn.mock.calls.map((c) => String(c[0])).find((l) => l.includes("account_mismatch"));
    expect(logged).toBeDefined();
    expect(JSON.parse(logged!)).toMatchObject({
      event: "account_mismatch",
      userId: "uid-me",
      requestedAccountId: OTHER,
    });
    warn.mockRestore();
  });

  it("does not leak whether the account exists — unknown id is also 403", async () => {
    // A 404 here would let anyone enumerate valid account ids.
    findById.mockResolvedValue(null);

    const res = await request(makeApp(accountMiddleware))
      .get("/probe")
      .set("X-Account-Id", "acc-does-not-exist");

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("account_forbidden");
  });

  it("checks membership by the ARRAY, not by whoever appears in the members map", async () => {
    // memberUids is what Firestore can query and what the rules will enforce.
    // Trusting the map instead would admit a user the query would never return.
    findById.mockResolvedValue(
      account(OWNED, { memberUids: [], members: { "uid-me": { role: "owner" } } })
    );

    const res = await request(makeApp(accountMiddleware))
      .get("/probe")
      .set("X-Account-Id", OWNED);

    expect(res.status).toBe(403);
  });
});

describe("a member gets context", () => {
  it("sets accountId and role from the verified account", async () => {
    const res = await request(makeApp(accountMiddleware))
      .get("/probe")
      .set("X-Account-Id", OWNED);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ accountId: OWNED, role: "owner" });
  });

  it("falls back to viewer when members and memberUids have drifted apart", async () => {
    // account.members[uid].role would throw a TypeError here — a 500 on EVERY
    // request that user makes. Least privilege on drift, never most.
    findById.mockResolvedValue(account(OWNED, { members: {} }));

    const res = await request(makeApp(accountMiddleware))
      .get("/probe")
      .set("X-Account-Id", OWNED);

    expect(res.status).toBe(200);
    expect(res.body.data.role).toBe("viewer");
  });
});

describe("no header — the fallback that keeps already-loaded tabs working", () => {
  it("resolves an existing membership without minting anything", async () => {
    const res = await request(makeApp(accountMiddleware)).get("/probe");

    expect(res.status).toBe(200);
    expect(res.body.data.accountId).toBe(OWNED);
    // ensureDefaultAccount fires ONLY on zero memberships. Minting whenever the
    // header is absent would strand a deleted channel's data behind a fresh id,
    // and would mint phantom channels for invite-only users.
    expect(ensureDefaultAccount).not.toHaveBeenCalled();
  });

  it("mints only when the user has no memberships at all", async () => {
    findByMember.mockResolvedValue([]);

    const res = await request(makeApp(accountMiddleware)).get("/probe");

    expect(res.status).toBe(200);
    expect(ensureDefaultAccount).toHaveBeenCalledWith("uid-me");
  });

  it("does not adopt a tombstoned channel as the fallback", async () => {
    // Adopting it would 410 every subsequent request with no way out.
    findByMember.mockResolvedValue([account(OWNED, { deletedAt: "2026-08-01" })]);

    await request(makeApp(accountMiddleware)).get("/probe");

    expect(ensureDefaultAccount).toHaveBeenCalledWith("uid-me");
  });

  // Phase 05 ships the fallback permissive because no client sends the header
  // yet; Phase 07 flips FALLBACK_ALLOWS_WRITES to false in the commit that makes
  // the frontend send it. Both settings are pinned so the flip is a one-line
  // change with a test already waiting for it.
  it("allows writes while FALLBACK_ALLOWS_WRITES is true (Phase 05)", async () => {
    const res = await request(makeApp(accountMiddleware)).post("/probe");

    expect(res.status).toBe(200);
  });

  // The Phase 07 setting, exercised for real rather than through a re-import.
  // `fallbackRejectsWrite` takes the flag as a parameter precisely so this branch
  // is reachable; asserting it via a condition rewritten in the test would prove
  // only that the test can write an if-statement.
  it.each([
    ["GET", false],
    ["HEAD", false],
    ["POST", true],
    ["PATCH", true],
    ["DELETE", true],
  ])("with the flag flipped, %s without a header is rejected: %s", (method, rejected) => {
    expect(fallbackRejectsWrite(method, false, false)).toBe(rejected);
  });

  it("never rejects when the header IS present, under either setting", () => {
    for (const allowWrites of [true, false]) {
      expect(fallbackRejectsWrite("POST", true, allowWrites)).toBe(false);
    }
  });
});

describe("a tombstoned channel is gone, not missing", () => {
  it("returns 410 and clears the pointer so there is a way out", async () => {
    findById.mockResolvedValue(account(OWNED, { deletedAt: "2026-08-01" }));

    const res = await request(makeApp(accountMiddleware))
      .get("/probe")
      .set("X-Account-Id", OWNED);

    expect(res.status).toBe(410);
    // Without this the pointer keeps naming a dead account and the user 410s
    // forever.
    expect(clearActiveAccount).toHaveBeenCalledWith("uid-me", OWNED);
  });
});

describe("the SSE route derives its account from the project, not the query string", () => {
  it("sets accountId and role from the project's account", async () => {
    findByIdUnchecked.mockResolvedValue({ id: "proj-1", createdBy: "uid-me", accountId: OWNED });

    const res = await request(makeApp(resolveAccountFromProject)).get("/stream/proj-1");

    expect(res.status).toBe(200);
    // req.role matters as much as accountId: Phase 09 puts requireRole("editor")
    // on exactly this route, and it skips accountMiddleware — so without this the
    // gate has nothing to read and viewers keep the one capability it withholds.
    expect(res.body.data).toEqual({ accountId: OWNED, role: "owner" });
  });

  it("403s when the caller is not a member of the PROJECT's account", async () => {
    // The check that carries all the weight here. Phase 06's
    // `project.accountId !== req.accountId` comparison can never fail on this
    // route, because both sides come from the same document.
    findByIdUnchecked.mockResolvedValue({ id: "proj-1", createdBy: "uid-other", accountId: OTHER });
    findById.mockResolvedValue(account(OTHER, { memberUids: ["uid-other"] }));

    const res = await request(makeApp(resolveAccountFromProject)).get("/stream/proj-1");

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("account_forbidden");
  });

  it("takes nothing account-related from the query string", async () => {
    findByIdUnchecked.mockResolvedValue({ id: "proj-1", createdBy: "uid-me", accountId: OWNED });

    const res = await request(makeApp(resolveAccountFromProject))
      .get(`/stream/proj-1?accountId=${OTHER}&token=x`);

    expect(res.status).toBe(200);
    expect(res.body.data.accountId).toBe(OWNED);
  });

  it("404s for a project that does not exist", async () => {
    findByIdUnchecked.mockResolvedValue(null);

    const res = await request(makeApp(resolveAccountFromProject)).get("/stream/nope");

    expect(res.status).toBe(404);
  });

  it("still streams for a legacy project written before Phase 03", async () => {
    // No accountId on the document until Phase 04 backfills it. Falling back to
    // the owner's account keeps the stream working through the migration window —
    // and the membership check still runs, so it is not a way in.
    findByIdUnchecked.mockResolvedValue({ id: "proj-1", createdBy: "uid-me" });

    const res = await request(makeApp(resolveAccountFromProject)).get("/stream/proj-1");

    expect(res.status).toBe(200);
    expect(ensureDefaultAccount).toHaveBeenCalledWith("uid-me");
    expect(res.body.data.accountId).toBe(OWNED);
  });
});
