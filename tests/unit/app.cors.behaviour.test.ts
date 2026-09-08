/**
 * CORS, because the whole multi-account model rides on one header.
 *
 * `app.ts` carries a four-line comment saying that dropping `'X-Account-Id'`
 * from `allowedHeaders` makes the browser strip it on every preflighted
 * request, the server fall back to the default channel, "and the whole suite
 * still passes". That was exactly true: `grep -rn "allowedHeaders\|cors" tests/`
 * returned nothing. The single most load-bearing line of configuration in the
 * migration was asserted by a code comment.
 *
 * The first version of this file preflighted for real and asserted the response
 * contained the header — and that sentence used to say "`cors` only echoes
 * headers it was configured with". It does not. With `allowedHeaders` unset,
 * `cors` REFLECTS whatever `Access-Control-Request-Headers` asked for, so all
 * four preflights passed with the option deleted outright. The suite read as
 * proof and was measuring the request.
 *
 * Hence both halves below: the explicit list must exist in the source, and a
 * preflight that asks for nothing (so there is nothing to reflect) must still
 * be told the header is allowed.
 */

jest.mock("../../src/config/firebase", () => ({
  db: {},
  auth: { verifyIdToken: jest.fn() },
  firebase: {
    firestore: {
      FieldValue: { serverTimestamp: jest.fn() },
      FieldPath: { documentId: jest.fn() },
    },
    auth: jest.fn().mockReturnValue({ verifyIdToken: jest.fn() }),
  },
}));

import fs from "fs";
import path from "path";
import request from "supertest";
import app from "../../src/app";

const ORIGIN = "http://localhost:5173";

const preflight = (requested: string) =>
  request(app)
    .options("/v1/ideas")
    .set("Origin", ORIGIN)
    .set("Access-Control-Request-Method", "GET")
    .set("Access-Control-Request-Headers", requested);

/**
 * `cors` REFLECTS `Access-Control-Request-Headers` when `allowedHeaders` is
 * unset, so a preflight that asks for `x-account-id` gets it echoed back even
 * with the option deleted entirely. Verified by running the real middleware
 * with no `allowedHeaders` at all — every "does the response contain it" test
 * still passed.
 *
 * So a preflight cannot tell "explicitly allowed" from "reflected", and the
 * first version of this suite proved nothing about the config. Two assertions
 * are needed: the explicit list must EXIST (below), and it must contain the
 * header (the preflights after it).
 */
describe("the allowlist is explicit, not reflected", () => {
  it("app.ts declares an explicit allowedHeaders list containing X-Account-Id", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "src", "app.ts"), "utf8");
    const match = source.match(/allowedHeaders:\s*\[([^\]]*)\]/);

    // Deleting the option is the regression a preflight cannot see.
    expect(match).not.toBeNull();
    const declared = match![1].toLowerCase();
    expect(declared).toContain("x-account-id");
    expect(declared).toContain("authorization");
    expect(declared).toContain("content-type");
  });

  it("and the browser is told so for a request that does NOT ask for it", async () => {
    // The behavioural half of the same check. With no `Access-Control-Request-
    // Headers` there is nothing to reflect, so whatever comes back is the
    // configured list — which is the only way a preflight can observe it.
    const res = await request(app)
      .options("/v1/ideas")
      .set("Origin", ORIGIN)
      .set("Access-Control-Request-Method", "GET");

    const allowed = String(res.headers["access-control-allow-headers"] ?? "").toLowerCase();
    expect(allowed).toContain("x-account-id");
  });
});

describe("preflight lets the browser send the channel header", () => {
  it("allows X-Account-Id", async () => {
    const res = await preflight("x-account-id");

    const allowed = String(res.headers["access-control-allow-headers"] ?? "").toLowerCase();
    expect(allowed).toContain("x-account-id");
  });

  it("still allows Authorization and Content-Type alongside it", async () => {
    // Adding the channel header by REPLACING the list rather than extending it
    // would break every authenticated request instead of quietly mis-scoping
    // them — different failure, same one-line edit.
    const res = await preflight("authorization,content-type,x-account-id");

    const allowed = String(res.headers["access-control-allow-headers"] ?? "").toLowerCase();
    expect(allowed).toContain("authorization");
    expect(allowed).toContain("content-type");
    expect(allowed).toContain("x-account-id");
  });

  it("sends credentials, so the Authorization header survives the round trip", async () => {
    const res = await preflight("x-account-id");

    expect(res.headers["access-control-allow-credentials"]).toBe("true");
  });

  it("answers the preflight for every method the API actually uses", async () => {
    // PATCH is the one that gets forgotten — the API uses it for every partial
    // update, and it is always preflighted.
    const res = await request(app)
      .options("/v1/user/profile")
      .set("Origin", ORIGIN)
      .set("Access-Control-Request-Method", "PATCH");

    const methods = String(res.headers["access-control-allow-methods"] ?? "").toUpperCase();
    for (const method of ["GET", "POST", "PATCH", "DELETE"]) {
      expect(methods).toContain(method);
    }
  });
});
