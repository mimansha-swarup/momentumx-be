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
const resolveActiveAccountId = jest.fn();
const findByIdUnchecked = jest.fn();

jest.mock("../../src/container", () => ({
  accountRepository: {
    findById: (...a: unknown[]) => findById(...a),
    findByMember: (...a: unknown[]) => findByMember(...a),
  },
  accountService: {
    ensureDefaultAccount: (...a: unknown[]) => ensureDefaultAccount(...a),
    clearActiveAccount: (...a: unknown[]) => clearActiveAccount(...a),
    resolveActiveAccountId: (...a: unknown[]) => resolveActiveAccountId(...a),
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

// `.doc(value)` splits on "/" and treats the result as a PATH. Both of these
// reached Firestore before the value was ever checked.
describe("a header that is not a document id never reaches .doc()", () => {
  it("refuses a header addressing a subcollection document", async () => {
    // This one RESOLVED: it read `accounts/<victim>/context/channel` — another
    // channel's niche, competitors and website scrape. Nothing was returned,
    // but only because that document has no memberUids for the check to pass.
    const res = await request(makeApp(accountMiddleware))
      .get("/probe")
      .set("X-Account-Id", `${OTHER}/context/channel`);

    expect(res.status).toBe(400);
    expect(findById).not.toHaveBeenCalled();
  });

  it("refuses a header addressing a collection, which used to be a 500", async () => {
    // An odd segment count makes `.doc()` throw a bare Error — no statusCode,
    // so the handler rendered "Something went wrong" on every protected route.
    const res = await request(makeApp(accountMiddleware))
      .get("/probe")
      .set("X-Account-Id", "a/b");

    expect(res.status).toBe(400);
    expect(findById).not.toHaveBeenCalled();
  });

  it("a well-formed but unknown id is still 403, not 400", async () => {
    // The distinction is the point: 400 says the client is broken, 403 says the
    // caller may not enter. Collapsing them would tell a prober which ids exist.
    findById.mockResolvedValue(null);

    const res = await request(makeApp(accountMiddleware))
      .get("/probe")
      .set("X-Account-Id", OTHER);

    expect(res.status).toBe(403);
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

  // The whole point of the pointer. Every test above this one seeds exactly ONE
  // membership, which is why the fallback could ignore `lastActiveAccountId`
  // entirely and stay green: with one channel, any rule picks the same channel.
  describe("with more than one live membership, the active pointer decides", () => {
    beforeEach(() => {
      // OTHER sorts second by document id, so `live[0]` is OWNED — i.e. these
      // tests fail if the pointer is ignored, rather than passing by luck.
      findByMember.mockResolvedValue([account(OWNED), account(OTHER)]);
    });

    it("acts in the channel the user activated, not the first one found", async () => {
      resolveActiveAccountId.mockResolvedValue(OTHER);

      const res = await request(makeApp(accountMiddleware)).get("/probe");

      expect(res.status).toBe(200);
      expect(res.body.data.accountId).toBe(OTHER);
    });

    it("writes land in the activated channel too, not just reads", async () => {
      // This is the data-destroying case: onboarding a newly created channel
      // wrote its niche and audience over the first channel's.
      resolveActiveAccountId.mockResolvedValue(OTHER);

      const res = await request(makeApp(accountMiddleware)).post("/probe");

      expect(res.body.data.accountId).toBe(OTHER);
    });

    it("uses the same resolver GET /v1/accounts reports activeAccountId from", async () => {
      resolveActiveAccountId.mockResolvedValue(OTHER);

      await request(makeApp(accountMiddleware)).get("/probe");

      // Passed the live memberships, so a pointer at a tombstoned or departed
      // channel can never be selected here.
      expect(resolveActiveAccountId).toHaveBeenCalledWith("uid-me", [
        expect.objectContaining({ id: OWNED }),
        expect.objectContaining({ id: OTHER }),
      ]);
    });

    it("falls back to a membership when the pointer names a channel they cannot enter", async () => {
      // A stale pointer is a bad GUESS, not an explicit request — it must not
      // lock the user out of channels that still work.
      resolveActiveAccountId.mockResolvedValue("acc-deleted-or-departed");

      const res = await request(makeApp(accountMiddleware)).get("/probe");

      expect(res.status).toBe(200);
      expect(res.body.data.accountId).toBe(OWNED);
    });

    it("never mints while any live membership exists", async () => {
      resolveActiveAccountId.mockResolvedValue(null);

      await request(makeApp(accountMiddleware)).get("/probe");

      expect(ensureDefaultAccount).not.toHaveBeenCalled();
    });
  });

  it("does not read the user record to disambiguate a single channel", async () => {
    // The pointer read is skipped when there is nothing to choose between, so
    // single-channel users keep paying one document read per request.
    await request(makeApp(accountMiddleware)).get("/probe");

    expect(resolveActiveAccountId).not.toHaveBeenCalled();
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

  // Phase 03 stamps accountId at creation, so an unstamped project is a bug,
  // not a legacy shape. There used to be a fallback that minted an account for
  // `project.createdBy` to cover pre-Phase-03 documents; it wrote an account and
  // a `lastActiveAccountId` onto a third party's user record, reachable by
  // anyone holding a project id, and ran BEFORE the membership check that then
  // refused them. Both the fallback and the documents it existed for are gone.
  it.each([["the caller"], ["someone else"]])(
    "refuses an unstamped project and mints nothing — created by %s",
    async (who) => {
      findByIdUnchecked.mockResolvedValue({
        id: "proj-1",
        createdBy: who === "the caller" ? "uid-me" : "uid-other",
      });

      const res = await request(makeApp(resolveAccountFromProject)).get("/stream/proj-1");

      expect(res.status).toBe(403);
      expect(res.body.code).toBe("account_forbidden");
      // Failing closed matters more than the status: a middleware that mints on
      // a missing field turns a data bug into writes on someone else's record.
      expect(ensureDefaultAccount).not.toHaveBeenCalled();
    }
  );
});
