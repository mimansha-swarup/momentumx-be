/**
 * `formatCreatorsData` — the channel-titles block of the idea prompt.
 *
 * This exists because of one production 500. `userTitle` holds the channel's
 * top VIDEO titles (a `string[]`, written by `formatUserData`), but the field
 * was typed `string`, so both writers of a brand-new channel context stored
 * `""`. The function destructured `const { titles = [] }`, and a default only
 * fires for `undefined` — so `"".map` threw a `TypeError`, which the error
 * handler masked as "Something went wrong" on the first "Generate ideas" click
 * of every new channel. A channel onboarded via niche + audience (no URL) never
 * gets titles written at all, so for those it was permanent, not a window.
 *
 * `tests/unit/idea-generation.test.ts` cannot catch this: it mocks this
 * function out entirely, and its context fixture omits `userTitle` rather than
 * setting it to the empty string production actually stores.
 */

// `src/utlils/content` pulls in the firebase config at import time, which reads
// a service-account env var. Same stub as the sibling util suites.
jest.mock("../../../src/config/firebase", () => ({
  db: {},
  auth: {},
  firebase: {
    firestore: { FieldValue: { serverTimestamp: jest.fn().mockReturnValue("SERVER_TS") } },
  },
}));

import { formatCreatorsData } from "../../../src/utlils/content";

describe("formatCreatorsData tolerates every shape userTitle is stored in", () => {
  // The empty string is the one that crashed, and it is still on disk for every
  // channel created before the type was corrected — so coercion has to stay
  // even though new writes are arrays.
  it.each([
    ["the empty string a fresh channel context stores", ""],
    ["absent, as legacy user records had it", undefined],
    ["null", null],
    ["a string, if anything ever writes one", "Some Channel"],
  ])("does not throw when userTitle is %s", (_label, userTitle) => {
    expect(() =>
      formatCreatorsData({ userName: "https://youtube.com/@acme", userTitle }, [])
    ).not.toThrow();
  });

  it("renders the titles when they are the array the field is meant to hold", () => {
    const result = formatCreatorsData(
      { userName: "https://youtube.com/@acme", userTitle: ["First video", "Second video"] },
      []
    );

    expect(result).toContain("https://youtube.com/@acme");
    expect(result).toContain("1. First video");
    expect(result).toContain("2. Second video");
  });

  it("still appends the avoid-list when previous titles exist", () => {
    const result = formatCreatorsData({ userName: "u", userTitle: [] }, ["Already generated"]);

    expect(result).toContain("Avoid Similar Titles");
    expect(result).toContain("1. Already generated");
  });
});
