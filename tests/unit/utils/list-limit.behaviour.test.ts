// What a client may ask the database for.
//
// Both list endpoints passed `?limit=` straight through to Firestore:
// `/v1/ideas` as `query.limit(parseInt(limit))`, `/v1/video-projects` as
// `query.limit(parseInt(limit) + 1)`. So `?limit=1000000` was a million-document
// read inside a Vercel function's time budget, and `?limit=abc` reached Firestore
// as `limit(NaN)`. `docs/features/video-project/api.md` already documented a
// maximum of 50; nothing enforced it and no test looked.

import {
  parseListLimit,
  IDEAS_PAGE,
  PROJECTS_PAGE,
} from "../../../src/utlils/pagination";

describe("parseListLimit — a client cannot choose the size of a database read", () => {
  it("caps an absurd request at the maximum instead of issuing it", () => {
    expect(parseListLimit("1000000", PROJECTS_PAGE)).toBe(50);
    expect(parseListLimit("1000000", IDEAS_PAGE)).toBe(50);
  });

  it("falls back rather than sending NaN to Firestore", () => {
    // `parseInt("abc")` is NaN, and `.limit(NaN)` is not a query anyone meant.
    expect(parseListLimit("abc", IDEAS_PAGE)).toBe(9);
    expect(parseListLimit("", IDEAS_PAGE)).toBe(9);
    expect(parseListLimit(undefined, IDEAS_PAGE)).toBe(9);
  });

  it("refuses zero and negatives, which return nothing or throw", () => {
    expect(parseListLimit("0", IDEAS_PAGE)).toBe(9);
    expect(parseListLimit("-5", IDEAS_PAGE)).toBe(9);
  });

  it("honours a sensible request unchanged", () => {
    expect(parseListLimit("12", IDEAS_PAGE)).toBe(12);
    expect(parseListLimit("50", PROJECTS_PAGE)).toBe(50);
  });

  it("keeps the documented defaults — 9 ideas per grid page, 20 projects", () => {
    expect(IDEAS_PAGE.fallback).toBe(9);
    expect(PROJECTS_PAGE.fallback).toBe(20);
  });

  it("ignores a non-string, which is what a repeated or nested param used to be", () => {
    expect(parseListLimit(["10", "20"] as unknown, IDEAS_PAGE)).toBe(9);
    expect(parseListLimit({ x: 1 } as unknown, IDEAS_PAGE)).toBe(9);
  });
});
