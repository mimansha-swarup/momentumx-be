// Contract (ai-generation-patterns.md): fillTemplate exists specifically because
// String.replace's *replacement string* form treats `$&`, `$'`, "$`", and `$$`
// as special patterns. A user-supplied value (a script, a title, a niche) that
// happens to contain one of those sequences must be inserted VERBATIM — that is
// the entire reason this helper exists instead of `.replace(token, value)`.
//
// It must also replace ALL occurrences of a token (subsuming the old /token/g
// call sites), and any placeholder left unfilled is a bug — a prompt shipped to
// Gemini with a literal "{placeholder}" in it is malformed input.

import { fillTemplate } from "../../../src/utlils/prompt-blocks";

describe("fillTemplate — verbatim insertion contract", () => {
  it("does not expand template-looking source text a second time", () => {
    expect(fillTemplate("{script} / {title}", { "{script}": "Keep {title} and $& literally", "{title}": "Real title" }))
      .toBe("Keep {title} and $& literally / Real title");
  });

  it.each([
    ["$&", "matches the whole match"],
    ["$`", "matches everything before the match"],
    ["$'", "matches everything after the match"],
    ["$$", "a literal dollar sign"],
    ["$1", "a capture group reference"],
    ["Show me the $$$ or $& else", "mixed real-world text"],
  ])("does not let String.replace expand %s (%s) found inside the value", (dangerous) => {
    const result = fillTemplate("Script: {script}", { "{script}": dangerous });
    expect(result).toBe(`Script: ${dangerous}`);
  });

  it("proves the danger is real: plain String.replace WOULD corrupt this exact value", () => {
    // This is the regression the helper guards against — if fillTemplate ever
    // regresses to `template.replace(token, value)`, this assertion is what
    // would start failing.
    const corrupted = "Script: {script}".replace("{script}", "$&$&");
    expect(corrupted).not.toBe("Script: $&$&");
    expect(corrupted).toBe("Script: {script}{script}");

    const safe = fillTemplate("Script: {script}", { "{script}": "$&$&" });
    expect(safe).toBe("Script: $&$&");
  });

  it("replaces every occurrence of a repeated token in the template", () => {
    const result = fillTemplate("{hook} ... later, remember: {hook}", {
      "{hook}": "Stop scrolling.",
    });
    expect(result).toBe("Stop scrolling. ... later, remember: Stop scrolling.");
  });

  it("fills multiple distinct placeholders independently", () => {
    const result = fillTemplate("{a}-{b}-{a}", { "{a}": "x", "{b}": "y" });
    expect(result).toBe("x-y-x");
  });

  it("inserts an empty string value without throwing and without leaving the token", () => {
    const result = fillTemplate("before{x}after", { "{x}": "" });
    expect(result).toBe("beforeafter");
  });

  it("does not touch a token that never appears in the template", () => {
    const result = fillTemplate("no placeholders here", { "{unused}": "value" });
    expect(result).toBe("no placeholders here");
  });

  it("BUG SURFACE: leaves a placeholder unfilled when the caller forgets to supply it", () => {
    // Per the rules file: "If a variable is optional, handle it before fill,
    // not after" — an unreplaced {placeholder} reaching Gemini is a bug in the
    // CALLER, not in fillTemplate. This test documents that fillTemplate itself
    // has no safety net for a missing key — callers must supply every token.
    const result = fillTemplate("Title: {title}, Niche: {niche}", { "{title}": "My Video" });
    expect(result).toBe("Title: My Video, Niche: {niche}");
    expect(result).toMatch(/\{niche\}/);
  });
});
