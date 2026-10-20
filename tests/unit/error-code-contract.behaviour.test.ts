// Phase 05's error contract, tested as a chain rather than per file.
//
// `code` has to survive four hops to be useful — HttpError → error_handler →
// sendError → JSON body — and if ANY link drops it nothing throws. The client
// simply cannot tell the three 403s apart, and Phase 07 renders all of them the
// same way. So these assert the value in the response body, which is the only
// place that proves every link is connected.
//
// Why it matters that they stay distinct:
//   account_forbidden → clear the account, eject to the channel list
//   wrong_account     → offer a one-click switch, DON'T eject
//   role_forbidden    → inline message, stay exactly where you are
// A viewer clicking something the UI failed to disable must not be thrown out of
// the channel, and someone opening a bookmarked project that lives in their other
// channel must not be told it was deleted.

import express from "express";
import request from "supertest";
import { responseFormatter } from "../../src/middleware/response_formatter";
import { useSharedServer } from "../integration/shared-server";
import { errorHandler } from "../../src/middleware/error_handler";
import {
  AccountForbidden,
  BadRequest,
  Forbidden,
  Gone,
  HttpError,
  RoleForbidden,
  WrongAccount,
} from "../../src/utlils/errors";

// ONE app, bound ONCE, with the thrown error swapped per request.
//
// This used to build a fresh Express app per call and hand it to `request()`, which
// makes supertest bind and tear down an ephemeral port every time — 10 sites here, and
// one of them fired three of them in parallel via Promise.all. That churn is the cause
// of an intermittent connection-level failure across the whole test process (see
// tests/integration/shared-server.ts); this file was observed failing that way on
// "keeps the three 403s distinguishable".
//
// `thrown` is module-level mutable state, so every probe must be AWAITED before the
// next is issued. The one test that used Promise.all is now sequential for that reason.
let thrown: unknown;
const app = express();
app.use(responseFormatter);
app.get("/probe", () => {
  throw thrown;
});
app.use(errorHandler);
const server = useSharedServer(app);

const probe = (err: unknown) => {
  thrown = err;
  return request(server()).get("/probe");
};

describe("the code reaches the response body", () => {
  it.each([
    ["account_forbidden", AccountForbidden(), 403],
    ["role_forbidden", RoleForbidden(), 403],
    ["wrong_account", WrongAccount({ accountId: "acc-1", displayName: "Cooking with Sam" }), 403],
  ])("%s survives the full chain", async (code, err, status) => {
    const res = await probe(err);

    expect(res.status).toBe(status);
    expect(res.body.code).toBe(code);
  });

  it("keeps the three 403s distinguishable from one another", async () => {
    const codes: unknown[] = [];
    for (const err of [AccountForbidden(), RoleForbidden(), WrongAccount({ accountId: "a" })]) {
      codes.push((await probe(err)).body.code);
    }

    expect(new Set(codes).size).toBe(3);
  });

  it("carries the owning channel on wrong_account, so the client can name it", async () => {
    // Without this the frontend renders "Project not found. It may have been
    // deleted." for a project that is one switch away — the worst sentence this
    // product can produce right after a tenancy migration.
    const res = await probe(WrongAccount({ accountId: "acc-1", displayName: "Cooking with Sam" }));

    expect(res.body.detail).toEqual({ accountId: "acc-1", displayName: "Cooking with Sam" });
  });
});

describe("errors that carry no code still behave exactly as before", () => {
  it("a plain Forbidden() has no code", async () => {
    const res = await probe(Forbidden());

    expect(res.status).toBe(403);
    expect(res.body.code).toBeUndefined();
  });

  it("a 400 is unchanged", async () => {
    const res = await probe(BadRequest("title is required"));

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ success: false, message: "title is required" });
  });

  it("a tombstoned channel is 410, not 404", async () => {
    // 404 says "it never existed" and is a dead end; 410 says "it did", which the
    // client can act on.
    const res = await probe(Gone());

    expect(res.status).toBe(410);
  });
});

describe("the 500 disclosure policy is not weakened by forwarding code and detail", () => {
  it("an unexpected throw leaks neither detail nor an internal message", async () => {
    const res = await probe(new Error("connect ECONNREFUSED 10.0.0.1:5432"));

    expect(res.status).toBe(500);
    expect(res.body.message).toBe("Something went wrong");
    expect(res.body.detail).toBeUndefined();
    expect(res.body.code).toBeUndefined();
  });

  it("does not forward detail from a 4xx that is NOT an author-written HttpError", async () => {
    // The one that actually leaks. `throw new Error("Forbidden")` resolves to 403
    // through STRING_SENTINELS, so it reaches the 4xx branch — and if that branch
    // reads `err.detail` off any object rather than off an HttpError, whatever a
    // service happened to attach goes to the client.
    //
    // An earlier version of this suite missed it: its only non-HttpError case was
    // a bare `new Error(...)`, which has no `detail` to leak, so widening the
    // forward to every object passed the whole file.
    const leaky = Object.assign(new Error("Forbidden"), {
      detail: { serviceAccountKey: "-----BEGIN PRIVATE KEY-----" },
    });

    const res = await probe(leaky);

    expect(res.status).toBe(403);
    expect(res.body.detail).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain("PRIVATE KEY");
  });

  it("does not forward a code from a non-HttpError either", async () => {
    // A forged `code` would drive the client's branch — `account_forbidden` ejects
    // the user out of their channel.
    const forged = Object.assign(new Error("Forbidden"), { code: "account_forbidden" });

    const res = await probe(forged);

    expect(res.body.code).toBeUndefined();
  });

  it("a 500-level HttpError still does not forward its detail", async () => {
    const err = new HttpError("internal", 500, { connectionString: "postgres://user:pw@host" });

    const res = await probe(err);

    expect(res.body.detail).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain("postgres://");
  });
});
