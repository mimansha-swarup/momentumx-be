/**
 * The external-adapter layer — both YouTube repositories, pinned at their single
 * seam (`youtubeJson`).
 *
 * `research.repository.ts` was the weakest file in the repo (26% of statements,
 * 0% of branches) and it is the file that decides whether a YouTube outage
 * degrades idea generation or takes it down. Three contracts live here and
 * nowhere else:
 *
 *  1. DEGRADATION. `.claude/rules/ai-generation-patterns.md`: "research is an
 *     enhancer, never a gate — every signal fetch failure resolves to an empty
 *     block and generation proceeds on channel context alone. Never let a
 *     YouTube error propagate out of ResearchContextService." The repository is
 *     documented as ALLOWED to reject ("Bound every call so a slow/dead response
 *     rejects; the caller then falls back to no research signals") — so the
 *     boundary contract is split and both halves are asserted below: the
 *     repository must turn every failure into one labelled, non-leaking
 *     rejection (and must NOT treat an empty result as a failure), and the
 *     service must turn every one of those into "".
 *
 *  2. REQUEST SHAPE. The niche and the keyword query are user-supplied values
 *     interpolated into a URL. Escaping is what stops "my niche&maxResults=50"
 *     from rewriting the request, and `SEARCH_QUALITY_PARAMS` is what keeps
 *     Shorts and livestreams out of the pool the model imitates.
 *
 *  3. ENTITY DECODING. "decode at the boundary so downstream prompts never see
 *     encoded text" (research.repository.ts).
 *
 * The seam: both repositories reach YouTube through `youtubeJson` and nothing
 * else, so mocking that one function makes the whole layer testable — and keeps
 * the cache/Firestore behaviour where it is tested for real
 * (tests/unit/youtube-cache.behaviour.test.ts).
 */

const youtubeJson = jest.fn();
jest.mock("../../../src/repository/youtube-cache.repository", () => ({
  youtubeJson: (...args: unknown[]) => youtubeJson(...args),
}));

// Both repositories read `YT_API` at module load, so it has to be set before the
// module is evaluated. Hence `require` rather than `import`: TypeScript hoists
// import declarations above every other statement in the file.
process.env.YT_API = "test-yt-key";
const ResearchRepository =
  require("../../../src/repository/research.repository").default;
const ExtractRepository =
  require("../../../src/repository/extract.repository").default;
const ResearchContextService =
  require("../../../src/service/research-context.service").default;

const research = new ResearchRepository();
const extract = new ExtractRepository();
const context = new ResearchContextService(research);

const lastUrl = () => new URL(youtubeJson.mock.calls.at(-1)![0] as string);
const item = (title: string, channelTitle = "Chan", videoId = "vid-1") => ({
  id: { videoId },
  snippet: { title, channelTitle },
});

const timeoutError = () =>
  Object.assign(new Error("The operation was aborted due to timeout"), {
    name: "TimeoutError",
  });

/**
 * The four ways YouTube actually fails in production. Every one of them must
 * degrade; none of them may reach a client or a prompt.
 */
const FAILURE_MODES: { name: string; arrange: () => void }[] = [
  {
    name: "an upstream failure (quota exhausted / 5xx)",
    arrange: () =>
      youtubeJson.mockRejectedValue(new Error("YouTube API unavailable")),
  },
  {
    name: "a timeout on a stalled connection",
    arrange: () => youtubeJson.mockRejectedValue(timeoutError()),
  },
  {
    name: "a malformed body",
    arrange: () =>
      youtubeJson.mockResolvedValue({ items: [{ unexpected: true }] }),
  },
  {
    name: "an empty items array",
    arrange: () => youtubeJson.mockResolvedValue({ items: [] }),
  },
];

beforeEach(() => {
  youtubeJson.mockReset();
});

describe("competitor channel names", () => {
  it("requests channel metadata by escaped id and decodes the display name", async () => {
    youtubeJson.mockResolvedValue({ items: [{ snippet: { title: "  Food &amp; Travel  " } }] });
    await expect(research.getChannelTitle("UC1&part=statistics")).resolves.toBe("Food & Travel");
    expect(lastUrl().pathname).toBe("/youtube/v3/channels");
    expect(lastUrl().searchParams.get("id")).toBe("UC1&part=statistics");
    expect(lastUrl().searchParams.getAll("part")).toEqual(["snippet"]);
  });

  it.each([null, {}, { items: [] }, { items: [{ snippet: {} }] }, { items: [{ snippet: { title: "   " } }] }])(
    "reports no name for missing channel metadata: %p", async (body) => {
      youtubeJson.mockResolvedValue(body);
      await expect(research.getChannelTitle("UC1")).resolves.toBeNull();
    }
  );

  it("sanitizes a failed name lookup before logging or rejecting", async () => {
    const log = jest.spyOn(console, "error").mockImplementation(() => {});
    try {
      youtubeJson.mockRejectedValue(new Error("failed?key=secret"));
      await expect(research.getChannelTitle("UC1")).rejects.toThrow("YouTube API unavailable — failed to fetch channel name");
      expect(log).toHaveBeenCalledWith(expect.stringContaining("key=[redacted]"));
      expect(log).not.toHaveBeenCalledWith(expect.stringContaining("secret"));
    } finally {
      log.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// 1. Degradation
// ---------------------------------------------------------------------------
describe("degradation — a YouTube outage must not take down generation", () => {
  // Harm prevented: "no results" is a normal Tuesday for a narrow niche; turning
  // it into an error would fail idea generation outright.
  it("treats an empty result as an empty research pool, not a failure", async () => {
    youtubeJson.mockResolvedValue({ items: [] });

    await expect(research.getTrendingVideos("baking")).resolves.toEqual([]);
    await expect(research.getKeywordSignals("baking")).resolves.toEqual([]);
    await expect(research.getChannelTopVideos("UC123")).resolves.toEqual([]);
    await expect(research.getVideoStats(["v1"])).resolves.toEqual({});
  });

  // A body with no `items` key at all is what a changed API shape or a cached
  // error payload looks like.
  it("treats a body with no items at all as an empty pool", async () => {
    for (const body of [{}, undefined, null]) {
      youtubeJson.mockResolvedValue(body);
      await expect(research.getTrendingVideos("baking")).resolves.toEqual([]);
      await expect(research.getKeywordSignals("baking")).resolves.toEqual([]);
      await expect(research.getChannelTopVideos("UC1")).resolves.toEqual([]);
      await expect(research.getVideoStats(["v1"])).resolves.toEqual({});
    }
  });

  // Harm prevented: a raw upstream error (or a TypeError from a shape change)
  // reaching the client as "Something went wrong", with upstream detail in it.
  describe.each(FAILURE_MODES.filter((m) => m.name !== "an empty items array"))(
    "$name",
    ({ arrange }) => {
      const callers: [string, () => Promise<unknown>][] = [
        ["trending videos", () => research.getTrendingVideos("baking")],
        ["keyword signals", () => research.getKeywordSignals("baking")],
        ["channel videos", () => research.getChannelTopVideos("UC123")],
      ];

      it.each(callers)(
        "rejects %s with one labelled YouTube-unavailable error",
        async (_label, call) => {
          arrange();
          await expect(call()).rejects.toThrow(/YouTube API unavailable/);
        }
      );

      it("names which fetch failed, so the log can tell them apart", async () => {
        arrange();
        const reasons = await Promise.all(
          callers.map(([, call]) => call().catch((e: Error) => e.message))
        );
        expect(reasons).toEqual([
          expect.stringContaining("trending videos"),
          expect.stringContaining("keyword signals"),
          expect.stringContaining("channel videos"),
        ]);
      });
    }
  );

  it("does not leak the upstream error text to the caller", async () => {
    youtubeJson.mockRejectedValue(
      new Error("connect ECONNREFUSED 10.0.0.7:443 key=test-yt-key")
    );

    const reason = await research
      .getTrendingVideos("baking")
      .catch((e: Error) => e.message);

    expect(reason).toMatch(/YouTube API unavailable/);
    expect(reason).not.toMatch(/ECONNREFUSED|10\.0\.0\.7|test-yt-key/);
  });

  // View counts are an annotation on titles we already have. Losing them must
  // cost the annotation, never the titles.
  it("keeps a malformed stats body from inventing view counts", async () => {
    youtubeJson.mockResolvedValue({ items: [{ unexpected: true }] });

    const stats = await research.getVideoStats(["v1"]);

    expect(stats).toEqual({});
  });

  it("never calls YouTube for an empty id list", async () => {
    await expect(research.getVideoStats([])).resolves.toEqual({});
    expect(youtubeJson).not.toHaveBeenCalled();
  });

  // ---- the service boundary: the contract the rules file actually states ----
  describe("ResearchContextService absorbs every one of them", () => {
    it.each(FAILURE_MODES)(
      "$name yields an empty signals block, not an error",
      async ({ arrange }) => {
        arrange();

        await expect(context.getIdeaSignals("baking")).resolves.toBe("");
        await expect(context.getTitleSignals("my working title")).resolves.toBe(
          ""
        );
      }
    );

    // Harm prevented: one dead signal fetch throwing away the other one's
    // grounding, so ideas silently stop citing live research.
    it("still grounds generation when only one of the two signal fetches fails", async () => {
      youtubeJson.mockImplementation((url: string) => {
        if (url.includes("order=viewCount")) {
          return Promise.reject(new Error("YouTube API unavailable"));
        }
        if (url.includes("/videos?")) return Promise.reject(timeoutError());
        return Promise.resolve({
          items: [item("How audiences search for sourdough", "Baker", "v9")],
        });
      });

      const block = await context.getIdeaSignals("baking");

      expect(block).toContain("How audiences search for sourdough");
      expect(block).toContain("What audiences are searching for:");
      // Trending died and stats timed out; neither may show up as an artefact.
      expect(block).not.toContain("Trending now in this niche:");
      expect(block).not.toMatch(/views/);
    });
  });
});

// ---------------------------------------------------------------------------
// 2. Request shape, escaping, and the quality filters
// ---------------------------------------------------------------------------
describe("request shape", () => {
  beforeEach(() => youtubeJson.mockResolvedValue({ items: [] }));

  // A niche is free text a creator typed during onboarding.
  const NASTY = "sourdough & rye / baking #1 café";

  it("sends the niche verbatim through escaping, and asks the search endpoint", async () => {
    await research.getTrendingVideos(NASTY);

    const url = lastUrl();
    expect(url.origin + url.pathname).toBe(
      "https://www.googleapis.com/youtube/v3/search"
    );
    expect(url.searchParams.get("q")).toBe(NASTY);
    expect(url.searchParams.get("order")).toBe("viewCount");
    expect(url.searchParams.get("type")).toBe("video");
    expect(url.searchParams.get("part")).toBe("snippet");
  });

  it("escapes the keyword query the same way", async () => {
    await research.getKeywordSignals(NASTY);

    expect(lastUrl().searchParams.get("q")).toBe(NASTY);
    expect(lastUrl().searchParams.get("order")).toBe("relevance");
  });

  // Harm prevented: a niche containing "&" rewriting the request — raising
  // maxResults, disabling the Shorts filter, or swapping the API key.
  it.each([
    ["trending", (q: string) => research.getTrendingVideos(q), "15"],
    ["keywords", (q: string) => research.getKeywordSignals(q), "20"],
  ])(
    "a %s query cannot inject request parameters",
    async (_name, call, expectedMax) => {
      await call("x&maxResults=50&videoDuration=short&key=attacker");

      const url = lastUrl();
      expect(url.searchParams.getAll("maxResults")).toEqual([expectedMax]);
      expect(url.searchParams.getAll("videoDuration")).toEqual(["medium"]);
      expect(url.searchParams.getAll("key")).toEqual(["test-yt-key"]);
    }
  );

  it("escapes a channel id on the competitor call", async () => {
    await research.getChannelTopVideos("UC1&maxResults=50");

    const url = lastUrl();
    expect(url.searchParams.get("channelId")).toBe("UC1&maxResults=50");
    expect(url.searchParams.getAll("maxResults")).toEqual(["10"]);
  });

  // `SEARCH_QUALITY_PARAMS`: videoDuration=medium (4-20 min) excludes Shorts and
  // livestreams; relevanceLanguage keeps results in the user's language. Harm
  // prevented: the model learns from Shorts spam and writes clickbait titles.
  it.each([
    ["trending", () => research.getTrendingVideos("baking")],
    ["keywords", () => research.getKeywordSignals("baking")],
  ])("%s asks YouTube to filter out Shorts and livestreams", async (_n, call) => {
    await call();

    expect(lastUrl().searchParams.get("videoDuration")).toBe("medium");
    expect(lastUrl().searchParams.get("relevanceLanguage")).toBe("en");
  });

  // Three deliberately different volumes: the keyword pool is the widest (it
  // feeds the "what audiences search for" block), trending sits in the middle,
  // and a single competitor channel contributes the least.
  it("asks for the volume each call site is sized for", async () => {
    await research.getKeywordSignals("baking");
    expect(lastUrl().searchParams.get("maxResults")).toBe("20");

    await research.getTrendingVideos("baking");
    expect(lastUrl().searchParams.get("maxResults")).toBe("15");

    await research.getChannelTopVideos("UC123");
    expect(lastUrl().searchParams.get("maxResults")).toBe("10");

    await extract.getYTChanelTitles("UC123");
    expect(lastUrl().searchParams.get("maxResults")).toBe("10");
  });

  // Harm prevented: dropping the window makes "trending" return all-time
  // classics, and the ideas grounded in them are years stale.
  it("limits trending to roughly the last 30 days, snapped to UTC midnight", async () => {
    await research.getTrendingVideos("baking");

    const publishedAfter = lastUrl().searchParams.get("publishedAfter")!;
    expect(publishedAfter).toMatch(/T00:00:00\.000Z$/);
    const ageDays = (Date.now() - Date.parse(publishedAfter)) / 86_400_000;
    expect(ageDays).toBeGreaterThan(29);
    expect(ageDays).toBeLessThan(32);
  });

  it("asks the videos endpoint for statistics only, for exactly the ids given", async () => {
    await research.getVideoStats(["v1", "v2"]);

    const url = lastUrl();
    expect(url.origin + url.pathname).toBe(
      "https://www.googleapis.com/youtube/v3/videos"
    );
    expect(url.searchParams.get("part")).toBe("statistics");
    expect(url.searchParams.get("id")).toBe("v1,v2");
  });

  it("maps view counts back onto their own video ids", async () => {
    youtubeJson.mockResolvedValue({
      items: [
        { id: "v1", statistics: { viewCount: "2400000" } },
        { id: "v2", statistics: {} },
      ],
    });

    await expect(research.getVideoStats(["v1", "v2"])).resolves.toEqual({
      v1: 2_400_000,
      v2: 0,
    });
  });

  it("asks the channel endpoint for the branding description on the handle path", async () => {
    youtubeJson.mockResolvedValue({ items: [] });

    await extract.retrieveChannelId("forHandle=@bakerbob");

    const url = lastUrl();
    expect(url.origin + url.pathname).toBe(
      "https://www.googleapis.com/youtube/v3/channels"
    );
    expect(url.searchParams.get("part")).toBe("id,brandingSettings");
    expect(url.searchParams.get("forHandle")).toBe("@bakerbob");
  });
});

// ---------------------------------------------------------------------------
// 3. HTML-entity decoding at the boundary
// ---------------------------------------------------------------------------
describe("entity decoding — prompts must never see encoded text", () => {
  const ENCODED =
    "Tom&#39;s &quot;best&quot; bread &amp; butter &lt;guide&gt; &apos;26 &#8212; day&#8217;s work";
  const DECODED = "Tom's \"best\" bread & butter <guide> '26 — day’s work";

  it.each([
    ["trending", (r: typeof research) => r.getTrendingVideos("baking")],
    ["keywords", (r: typeof research) => r.getKeywordSignals("baking")],
  ])("decodes every documented entity form on %s titles", async (_n, call) => {
    youtubeJson.mockResolvedValue({ items: [item(ENCODED)] });

    const [video] = (await call(research)) as { title: string }[];

    expect(video.title).toBe(DECODED);
    expect(video.title).not.toMatch(/&(amp|quot|apos|lt|gt|#\d+);/);
  });

  it("leaves a title with no entities untouched", async () => {
    youtubeJson.mockResolvedValue({
      items: [item("Plain title, nothing encoded")],
    });

    const [video] = await research.getTrendingVideos("baking");
    expect(video.title).toBe("Plain title, nothing encoded");
  });

  /**
   * WAS A BUG, now fixed. `decodeEntities` runs the numeric pass
   * BEFORE `&amp;`, so a double-encoded title — which the search API really does
   * return — is only half decoded: `&amp;#39;` becomes `&#39;` and goes into the
   * prompt as visible markup. The stated intent is absolute: "decode at the
   * boundary so downstream prompts never see encoded text".
   *
   * Decoding now loops until the string stops changing (utlils/regex.ts), because
   * "&amp;#39;" needs "&amp;" -> "&" before "&#39;" is a recognisable entity at all.
   */
  it("fully decodes a double-encoded title", async () => {
    youtubeJson.mockResolvedValue({ items: [item("Tom&amp;#39;s bakery tour")] });

    const [video] = await research.getTrendingVideos("baking");

    expect(video.title).toBe("Tom's bakery tour");
  });

  /**
   * WAS A BUG, now fixed. `getChannelTopVideos` calls the SAME
   * search endpoint as the two decoded calls, in the same file, under the same
   * stated intent — and returns its titles raw. They are served to the client by
   * GET /v1/research/competitors, so the competitor panel renders "Ben &amp;
   * Jerry&#39;s".
   */
  /**
   * `channelTitle` was never decoded on either decoded call. It is displayed to the
   * creator in the trending/keyword panels and travels into prompts beside the
   * title it belongs to, so "Bon App&#233;tit" reached both as visible markup.
   */
  it("decodes the channel name, not just the video title", async () => {
    youtubeJson.mockResolvedValue({
      items: [item("A title", "Bon App&#233;tit &amp; Co")],
    });

    const [video] = await research.getTrendingVideos("baking");

    expect(video.channelTitle).toBe("Bon Appétit & Co");
  });

  it("decodes competitor titles too", async () => {
    youtubeJson.mockResolvedValue({
      items: [{ snippet: { title: "Ben &amp; Jerry&#39;s factory tour" } }],
    });

    await expect(research.getChannelTopVideos("UC123")).resolves.toEqual([
      "Ben & Jerry's factory tour",
    ]);
  });

  /**
   * WAS A BUG, now fixed. `extract.repository.getYTChanelTitles`
   * hits the same search endpoint, and its titles land in the channel context
   * (`userTitle`) that `utlils/content.ts` formats straight INTO the generation
   * prompt — which is precisely the case the decoding comment describes.
   */
  it("decodes the channel's own top titles, which go into the prompt", async () => {
    youtubeJson.mockResolvedValue({
      items: [{ snippet: { title: "My channel&#39;s top video &amp; more" } }],
    });

    await expect(extract.getYTChanelTitles("UC123")).resolves.toEqual([
      "My channel's top video & more",
    ]);
  });
});

// ---------------------------------------------------------------------------
// extract.repository — the onboarding half of the same seam
// ---------------------------------------------------------------------------
describe("ExtractRepository", () => {
  /**
   * The onboarding half escaped nothing: `channelId` and the `forHandle=`/
   * `forUsername=` value were interpolated raw. It was safe only because
   * extractChannelInfo's character class happens to exclude & and #, i.e. one
   * regex widening from a forged request — and research.repository escaped the
   * same values, so the two halves of one seam disagreed.
   */
  it("cannot have a parameter injected through the channel id", async () => {
    youtubeJson.mockResolvedValue({ items: [] });

    await extract.getYTChanelTitles("UC123&maxResults=50&key=attacker");

    const url = youtubeJson.mock.calls[0][0] as string;
    expect(url).not.toContain("maxResults=50");
    expect(url).not.toContain("key=attacker");
    // Exactly one of each real parameter, with the hostile text inert inside the id.
    expect(url.match(/[?&]maxResults=/g)).toHaveLength(1);
    expect(url.match(/[?&]key=/g)).toHaveLength(1);
    expect(url).toContain("UC123%26maxResults%3D50%26key%3Dattacker");
  });

  it("maps the channel's top video titles", async () => {
    youtubeJson.mockResolvedValue({
      items: [{ snippet: { title: "First" } }, { snippet: { title: "Second" } }],
    });

    await expect(extract.getYTChanelTitles("UC123")).resolves.toEqual([
      "First",
      "Second",
    ]);
  });

  // `resolveChannel` (utlils/content.ts) guards with `?? []`, so a missing
  // `items` must stay falsy-or-empty rather than becoming a crash.
  it("survives a body with no items", async () => {
    youtubeJson.mockResolvedValue({});

    await expect(extract.getYTChanelTitles("UC123")).resolves.toBeUndefined();
  });

  // Harm prevented: onboarding hangs or 500s on a YouTube outage instead of
  // degrading — `resolveChannel` can only degrade if the error reaches it.
  it("propagates an upstream failure so resolveChannel can degrade", async () => {
    youtubeJson.mockRejectedValue(new Error("YouTube API unavailable"));

    await expect(extract.getYTChanelTitles("UC123")).rejects.toThrow(
      /YouTube API unavailable/
    );
    await expect(extract.retrieveChannelId("forHandle=@x")).rejects.toThrow(
      /YouTube API unavailable/
    );
  });

  it("hands the channel lookup body back unchanged", async () => {
    const body = {
      items: [
        { id: "UC123", brandingSettings: { channel: { description: "hi" } } },
      ],
    };
    youtubeJson.mockResolvedValue(body);

    await expect(extract.retrieveChannelId("forUsername=bob")).resolves.toBe(
      body
    );
  });
});

/**
 * The four `youtube_fetch_failed` logs record the upstream reason so a YouTube outage is
 * diagnosable rather than silently degraded. That reason is UNTRUSTED text: every URL in
 * this file carries `key=${API_KEY}`, and `response.json()` throws a SyntaxError whose
 * message can quote the response body — so a malformed upstream response that echoed the
 * request would have written the API key into the logs.
 */
describe("the failure log never carries the API key", () => {
  it("redacts key= from a reason that quoted the request URL", async () => {
    const error = new SyntaxError(
      'Unexpected token < in JSON: <html>https://www.googleapis.com/youtube/v3/search?key=AIzaSyLEAKED987&q=x</html>'
    );
    youtubeJson.mockRejectedValue(error);
    const logged: string[] = [];
    const spy = jest.spyOn(console, "error").mockImplementation((line) => {
      logged.push(String(line));
    });

    await expect(research.getTrendingVideos("baking")).rejects.toThrow();

    spy.mockRestore();
    expect(logged.join("\n")).toContain("youtube_fetch_failed");
    expect(logged.join("\n")).not.toContain("AIzaSyLEAKED987");
    expect(logged.join("\n")).toContain("key=[redacted]");
  });
});
