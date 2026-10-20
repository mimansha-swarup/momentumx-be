import { extractChannelInfo, decodeEntities } from "../../../src/utlils/regex";

/**
 * `extractChannelInfo` is the trust boundary for channel URLs. Its captured value is
 * interpolated into a YouTube API query (`forHandle=@<value>`) by extract.service,
 * and from there into a URL by extract.repository.
 *
 * WHY THIS FILE EXISTS. extract.service escapes that value with encodeURIComponent,
 * but removing the escaping entirely fails NO test — because this character class
 * can never produce a value that needs escaping. The escaping is defense in depth;
 * the regex is what actually prevents parameter injection today.
 *
 * So this pins the regex. Widen the character class to admit `&`, `#`, `=` or `/`
 * and these tests fail — which is the alarm telling you the escaping has just become
 * load-bearing, and that extract.repository's interpolation is now reachable.
 */
describe("extractChannelInfo — the trust boundary for a user-supplied channel URL", () => {
  it("captures an ordinary handle", () => {
    expect(extractChannelInfo("https://youtube.com/@some.channel-1")).toEqual({
      type: "handle",
      value: "some.channel-1",
    });
  });

  it.each([
    ["&", "https://youtube.com/@x&maxResults=50"],
    ["#", "https://youtube.com/@x#frag"],
    ["=", "https://youtube.com/@x=y"],
    ["/", "https://youtube.com/@x/extra"],
    ["?", "https://youtube.com/@x?key=attacker"],
  ])("never captures %s into the value it hands downstream", (_char, url) => {
    const info = extractChannelInfo(url);
    // It may match a PREFIX, but the captured value must stay inert: no character
    // that could terminate one query parameter and begin another.
    expect(info?.value ?? "").toMatch(/^[a-zA-Z0-9._-]*$/);
  });

  it("returns null for a non-YouTube URL rather than guessing", () => {
    expect(extractChannelInfo("https://example.com/nope")).toBeNull();
  });

  it("requires a channel id to be the full 24 characters", () => {
    // A short id is not a channel id; treating it as one sends a guaranteed-404
    // lookup and costs a quota unit.
    expect(extractChannelInfo("https://youtube.com/channel/UCtooshort")).toBeNull();
  });
});

describe("decodeEntities — one token-based pass, and what it deliberately does NOT do", () => {
  it("decodes every NON-ampersand entity family at the same depth, double-escaped or not", () => {
    // Consistency assertion: under the old ordered chain, "&amp;" decoded first and its
    // output got picked up by a later rule for the numeric family but not for &quot; —
    // so a double-escaped apostrophe fully decoded while a double-escaped quote didn't.
    // The optional "amp;" prefix in ENTITY_PATTERN matches BOTH depths as one token for
    // every family, so numeric and named entities now undo one layer of transport
    // escaping identically.
    expect(decodeEntities("Tom&amp;#39;s")).toBe("Tom's");
    expect(decodeEntities("Learn &amp;quot; in HTML")).toBe('Learn " in HTML');
  });

  it("&amp; alone is the ampersand entity itself, not a prefix with nothing behind it", () => {
    // The one residual ambiguity: a title that genuinely wants to display the literal
    // text "&amp;" is indistinguishable from a lone transport-escaped ampersand, and
    // this resolves in favour of undoing the escaping — same as "&amp;amp;" -> "&".
    expect(decodeEntities("Learn &amp; in HTML")).toBe("Learn & in HTML");
    expect(decodeEntities("Learn &amp;amp; in HTML")).toBe("Learn & in HTML");
  });

  it("decodes decimal numeric entities to astral characters, not broken surrogates", () => {
    // fromCharCode truncated above U+FFFF, so this emoji arrived as a lone surrogate.
    // Emoji are ubiquitous in YouTube titles, so this reached prompts constantly.
    expect(decodeEntities("&#128512; baking")).toBe("\u{1F600} baking");
  });

  it("decodes hex numeric entities too, in either case for the x", () => {
    expect(decodeEntities("&#x1F600; baking")).toBe("\u{1F600} baking");
    expect(decodeEntities("&#X1F600; baking")).toBe("\u{1F600} baking");
  });

  it("leaves a lone surrogate code point alone instead of emitting broken UTF-16", () => {
    // 0xD800 is inside the 0..0x10FFFF numeric guard but is not a valid scalar value —
    // fromCodePoint would either throw or emit an unpaired surrogate that corrupts
    // downstream JSON encoding.
    expect(decodeEntities("&#55296;")).toBe("&#55296;");
  });

  it("leaves an out-of-range numeric entity alone instead of throwing", () => {
    // fromCodePoint throws above U+10FFFF. A malformed upstream title must not take
    // down idea generation.
    expect(decodeEntities("&#1114112;")).toBe("&#1114112;");
  });

  it("leaves already-decoded text untouched", () => {
    expect(decodeEntities("Ben & Jerry's — 100% fine")).toBe("Ben & Jerry's — 100% fine");
  });
});
