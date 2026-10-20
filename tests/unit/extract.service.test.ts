// Phase 01 item 8. `getWebsiteContent` fetches a URL the USER supplies and stores
// the result on their record. It had no cap, no timeout and no SSRF screen.

import ExtractService from "../../src/service/extract.service";
import ExtractRepository from "../../src/repository/extract.repository";

const makeService = () =>
  new ExtractService({} as unknown as ExtractRepository);

// Minimal Response stand-in: a single-chunk body plus headers.
const htmlResponse = (html: string, headers: Record<string, string> = {}) => {
  const bytes = new TextEncoder().encode(html);
  let sent = false;
  return {
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    body: {
      getReader: () => ({
        read: async () =>
          sent ? { done: true, value: undefined } : ((sent = true), { done: false, value: bytes }),
        cancel: async () => {},
      }),
    },
  } as unknown as Response;
};

describe("ExtractService.getWebsiteContent", () => {
  const realFetch = global.fetch;

  afterEach(() => {
    global.fetch = realFetch;
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it("extracts text and strips tags", async () => {
    global.fetch = jest.fn().mockResolvedValue(
      htmlResponse("<html><body><h1>Sourdough</h1><p>Baking guide</p></body></html>")
    ) as unknown as typeof fetch;

    await expect(makeService().getWebsiteContent("https://example.com")).resolves.toBe(
      "Sourdough Baking guide"
    );
  });

  // The whole reason Phase 02 splits channel context into a subcollection is that
  // this value was unbounded on a document read by every request.
  it("caps the stored text at 20k characters", async () => {
    const huge = "<p>" + "a".repeat(60_000) + "</p>";
    global.fetch = jest.fn().mockResolvedValue(htmlResponse(huge)) as unknown as typeof fetch;

    const out = await makeService().getWebsiteContent("https://example.com");

    expect(out.length).toBe(20_000);
  });

  /**
   * A stalled connection must actually be aborted, at the documented 8s bound.
   *
   * This test used to assert `{ signal: expect.anything() }` — which a
   * never-aborted `new AbortController().signal` satisfies, and so does a 10
   * minute bound. Neither would keep onboarding from hanging, which is the only
   * reason the signal exists.
   *
   * `AbortSignal.timeout` is driven by a Node-internal timer that jest's fake
   * timers do NOT patch (verified: advancing 8001ms leaves `signal.aborted`
   * false), so the timer wiring — and only the wiring — is re-hosted on the
   * faked global `setTimeout`. The delay asserted is the real one, read off the
   * real call, and the abort still travels through the service's own signal: if
   * the source stopped passing it, or asked for a different bound, this fails.
   */
  it("aborts a stalled connection at the 8s bound instead of hanging", async () => {
    jest.useFakeTimers();
    const requested: unknown[] = [];
    jest.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
      requested.push(ms);
      const controller = new AbortController();
      setTimeout(
        () => controller.abort(new DOMException("timed out", "TimeoutError")),
        ms as number
      );
      return controller.signal;
    });

    // A connection that accepts the request and then says nothing.
    global.fetch = jest.fn((_url, init: RequestInit = {}) =>
      new Promise((_resolve, reject) => {
        if (!init.signal) {
          reject(new Error("fetch was called with no abort signal"));
          return;
        }
        init.signal.addEventListener("abort", () =>
          reject(init.signal!.reason)
        );
      })
    ) as unknown as typeof fetch;

    let outcome: string = "pending";
    const settled = makeService()
      .getWebsiteContent("https://example.com")
      .then(
        () => (outcome = "resolved"),
        (error: Error) => (outcome = error.name)
      );

    await Promise.resolve(); // let the fetch call happen
    expect(requested).toEqual([8000]); // the real bound, not "some signal"

    jest.advanceTimersByTime(7999);
    await Promise.resolve();
    expect(outcome).toBe("pending"); // not cut off early either

    jest.advanceTimersByTime(1);
    await settled;
    expect(outcome).toBe("TimeoutError");
  });

  it("rejects an oversized declared body without reading it", async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValue(htmlResponse("<p>hi</p>", { "content-length": "99000000" }));
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      makeService().getWebsiteContent("https://example.com")
    ).rejects.toThrow(/too large/i);
  });

  // ---------------------------------------------------------------------------
  // SSRF screen. A server-side fetch of a user-supplied URL will happily retrieve
  // an internal host and store the response where the user can read it back.
  // ---------------------------------------------------------------------------
  describe("refuses to fetch private and non-http targets", () => {
    const blocked = [
      "http://169.254.169.254/latest/meta-data/", // cloud metadata
      "http://localhost:8080/admin",
      "http://127.0.0.1/",
      "http://10.0.0.5/",
      "http://192.168.1.1/",
      "http://172.16.0.9/",
      "http://db.internal/",
      "file:///etc/passwd",
      "gopher://example.com/",
    ];

    it.each(blocked)("blocks %s", async (url) => {
      const fetchMock = jest.fn();
      global.fetch = fetchMock as unknown as typeof fetch;

      await expect(makeService().getWebsiteContent(url)).rejects.toThrow();
      expect(fetchMock).not.toHaveBeenCalled(); // refused BEFORE the request
    });
  });

  // ---------------------------------------------------------------------------
  // The screen must not cost legitimate addresses. The first cut applied the IP
  // range patterns to the HOSTNAME, which refused ordinary public domains that
  // merely begin with a digit — `0.pool.ntp.org` and `0.gravatar.com` are both
  // real. Reserved-TLD checks are anchored so only the reserved label matches.
  // ---------------------------------------------------------------------------
  describe("does not over-block public hostnames", () => {
    const allowed = [
      "https://0.pool.ntp.org/",       // digit-leading DNS name, not an IP
      "https://0.gravatar.com/avatar", // same
      "https://10.downloads.example.com/",
      "https://127.example.com/",
      "https://localhost.com/",        // a real registrable domain
      "https://mylocalhost.com/",
      "https://local.com/",
      "https://internal.com/",
      "https://shop.local.example.com/", // `.local` only reserved as the final label
      "https://172.32.0.1/",             // outside the private 172.16–31 range
    ];

    it.each(allowed)("allows %s", async (url) => {
      const fetchMock = jest.fn().mockResolvedValue(htmlResponse("<p>ok</p>"));
      global.fetch = fetchMock as unknown as typeof fetch;

      await expect(makeService().getWebsiteContent(url)).resolves.toBe("ok");
      expect(fetchMock).toHaveBeenCalled();
    });
  });

  it("blocks IPv6 loopback and unique-local literals", async () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    for (const url of ["http://[::1]/", "http://[fd00::1]/", "http://[fe80::1]/"]) {
      await expect(makeService().getWebsiteContent(url)).rejects.toThrow(/private/i);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // `new URL()` rewrites ::ffff:10.0.0.1 to its hex form ::ffff:a00:1, so a check
  // that only understood the dotted-quad the user typed let this straight through.
  it("blocks IPv4-mapped IPv6 that wraps a private address", async () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    for (const url of [
      "http://[::ffff:10.0.0.1]/",
      "http://[::ffff:127.0.0.1]/",
      "http://[::ffff:169.254.169.254]/",
    ]) {
      await expect(makeService().getWebsiteContent(url)).rejects.toThrow(/private/i);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("still allows an IPv4-mapped IPv6 wrapping a public address", async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue(htmlResponse("<p>ok</p>")) as unknown as typeof fetch;

    await expect(makeService().getWebsiteContent("http://[::ffff:8.8.8.8]/")).resolves.toBe("ok");
  });

  it("rejects a malformed URL", async () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(makeService().getWebsiteContent("not a url")).rejects.toThrow(/invalid/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("still allows an ordinary public site", async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue(htmlResponse("<p>ok</p>")) as unknown as typeof fetch;

    await expect(
      makeService().getWebsiteContent("https://my-brand.example.com/about")
    ).resolves.toBe("ok");
  });
});

/**
 * `retrieveChannelId` builds a raw query fragment (`forHandle=@x`) that the
 * repository interpolates straight into a YouTube URL. The value comes from a
 * user-supplied channel URL, so it is the injection point — and it had no test at
 * all, which is why this exists.
 *
 * The `@` must stay literal (that is the form YouTube documents); only the value
 * is escaped.
 */
describe("ExtractService.retrieveChannelId — the query fragment it hands the repository", () => {
  const withRepo = () => {
    const repo = {
      retrieveChannelId: jest.fn().mockResolvedValue({ items: [{ id: "UC-resolved" }] }),
    } as unknown as ExtractRepository;
    return { repo, service: new ExtractService(repo) };
  };

  it("keeps the @ literal for a handle and escapes only the value", async () => {
    const { repo, service } = withRepo();

    await service.retrieveChannelId("https://youtube.com/@some.channel-1");

    expect(repo.retrieveChannelId).toHaveBeenCalledWith("forHandle=@some.channel-1");
  });

  it("uses forUsername for a legacy custom URL", async () => {
    const { repo, service } = withRepo();

    await service.retrieveChannelId("https://youtube.com/c/LegacyName");

    expect(repo.retrieveChannelId).toHaveBeenCalledWith("forUsername=LegacyName");
  });

  it("returns a direct channel id without asking the API at all", async () => {
    // 24-char channel ids need no lookup; spending a quota unit on one is waste.
    const { repo, service } = withRepo();

    const id = await service.retrieveChannelId(
      "https://youtube.com/channel/UCabcdefghijklmnopqrstuv"
    );

    expect(id).toBe("UCabcdefghijklmnopqrstuv");
    expect(repo.retrieveChannelId).not.toHaveBeenCalled();
  });

  it("rejects a URL it cannot parse instead of querying with a broken fragment", async () => {
    const { repo, service } = withRepo();

    await expect(service.retrieveChannelId("https://example.com/nope")).rejects.toThrow(
      "Invalid YouTube channel URL"
    );
    expect(repo.retrieveChannelId).not.toHaveBeenCalled();
  });
});
