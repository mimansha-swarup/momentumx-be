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
 * Preflighted for real rather than grepped, because the failure is a browser
 * behaviour: `cors` only echoes headers it was configured with, and a config
 * that reads fine can still answer a preflight wrongly.
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

import request from "supertest";
import app from "../../src/app";

const ORIGIN = "http://localhost:5173";

const preflight = (requested: string) =>
  request(app)
    .options("/v1/ideas")
    .set("Origin", ORIGIN)
    .set("Access-Control-Request-Method", "GET")
    .set("Access-Control-Request-Headers", requested);

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
