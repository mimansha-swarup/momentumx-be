jest.mock("../../src/config/firebase", () => require("../helpers/fake-firestore").mockFirebase());
import { youtubeJson } from "../../src/repository/youtube-cache.repository";
import { createHash } from "node:crypto";
const firebaseMock = require("../../src/config/firebase");
const realFetch = global.fetch;
afterEach(() => { global.fetch = realFetch; jest.useRealTimers(); jest.restoreAllMocks(); });
it("coalesces identical public queries, separates keys, and expires after six hours", async () => {
  jest.useFakeTimers().setSystemTime(new Date("2026-09-26T00:00:00Z"));
  const fetcher = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ items: ["title"] }) });
  global.fetch = fetcher as any;
  await Promise.all([youtubeJson("https://youtube.test/search?q=finance&region=IN"), youtubeJson("https://youtube.test/search?q=finance&region=IN")]);
  expect(fetcher).toHaveBeenCalledTimes(1);
  await youtubeJson("https://youtube.test/search?q=finance&region=US");
  await youtubeJson("https://youtube.test/search?q=music&region=IN");
  expect(fetcher).toHaveBeenCalledTimes(3);
  jest.advanceTimersByTime(6 * 60 * 60 * 1000 + 1);
  await youtubeJson("https://youtube.test/search?q=finance&region=IN");
  expect(fetcher).toHaveBeenCalledTimes(4);
});
it("never caches failed responses", async () => {
  const fetcher = jest.fn().mockResolvedValueOnce({ ok: false }).mockResolvedValueOnce({ ok: true, json: async () => ({ items: [] }) });
  global.fetch = fetcher as any;
  await expect(youtubeJson("https://youtube.test/failure")).rejects.toThrow("unavailable");
  await expect(youtubeJson("https://youtube.test/failure")).resolves.toEqual({ items: [] });
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it("reads the shared cache on a cold local key without calling YouTube", async () => {
  const url = "https://youtube.test/channels?channelId=public-channel&key=secret-api-key";
  const key = createHash("sha256").update("https://youtube.test/channels?channelId=public-channel").digest("hex");
  firebaseMock.__db.seed("youtubeCache", [{ id: key.slice(0, 2), key, expiresAt: Date.now() + 60_000, data: { items: ["cached-title"] } }]);
  global.fetch = jest.fn() as any;
  await expect(youtubeJson(url)).resolves.toEqual({ items: ["cached-title"] });
  expect(global.fetch).not.toHaveBeenCalled();
});
it("does not serve a colliding shared slot for another query", async () => {
  const url = "https://youtube.test/channel?channelId=another";
  const key = createHash("sha256").update(url).digest("hex");
  firebaseMock.__db.seed("youtubeCache", [{ id: key.slice(0, 2), key: "different", expiresAt: Date.now() + 60_000, data: { items: ["wrong"] } }]);
  global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ items: ["right"] }) }) as any;
  await expect(youtubeJson(url)).resolves.toEqual({ items: ["right"] });
  expect(global.fetch).toHaveBeenCalledTimes(1);
});
it("retains the original shared expiry when warming a cold local cache", async () => {
  jest.useFakeTimers().setSystemTime(new Date("2026-09-26T00:00:00Z"));
  const url = "https://youtube.test/search?q=near-expiry";
  const key = createHash("sha256").update(url).digest("hex");
  firebaseMock.__db.seed("youtubeCache", [{ id: key.slice(0, 2), key, expiresAt: Date.now() + 60_000, data: { items: ["old"] } }]);
  global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ items: ["fresh"] }) }) as any;
  await expect(youtubeJson(url)).resolves.toEqual({ items: ["old"] });
  jest.advanceTimersByTime(60_001);
  await expect(youtubeJson(url)).resolves.toEqual({ items: ["fresh"] });
  expect(global.fetch).toHaveBeenCalledTimes(1);
});

/**
 * The 8s bound, at the one place it exists.
 *
 * `fetch()` has no implicit timeout, and this function is the only thing standing
 * between a stalled YouTube socket and a request that never answers — research is
 * documented to DEGRADE on failure, which it can only do if the failure arrives.
 * Nothing pinned the bound before, so it could have been deleted or widened to a
 * minute without a single test noticing.
 *
 * `AbortSignal.timeout` runs on a Node-internal timer that jest's fake timers do
 * not patch, so only that timer wiring is re-hosted on the faked global
 * `setTimeout`; the delay asserted is the real argument from the real call.
 */
it("bounds every YouTube fetch at 8s so a stalled connection rejects instead of hanging", async () => {
  jest.useFakeTimers();
  const requested: unknown[] = [];
  jest.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
    requested.push(ms);
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException("timed out", "TimeoutError")), ms as number);
    return controller.signal;
  });
  global.fetch = jest.fn((_url, init: RequestInit = {}) =>
    new Promise((_resolve, reject) => {
      if (!init.signal) return reject(new Error("fetch was called with no abort signal"));
      init.signal.addEventListener("abort", () => reject(init.signal!.reason));
    })
  ) as any;
  const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

  let outcome = "pending";
  const settled = youtubeJson("https://youtube.test/search?q=stalled-socket").then(
    () => (outcome = "resolved"),
    (error: Error) => (outcome = error.name)
  );

  await flush();
  expect(requested).toEqual([8000]);
  jest.advanceTimersByTime(7999);
  await flush();
  expect(outcome).toBe("pending");

  jest.advanceTimersByTime(1);
  await settled;
  expect(outcome).toBe("TimeoutError");
  jest.restoreAllMocks();
});

it("continues past stalled shared-cache reads and writes without waiting forever", async () => {
  jest.useFakeTimers();
  const pending = () => new Promise<never>(() => {});
  const originalCollection = firebaseMock.db.collection.bind(firebaseMock.db);
  jest.spyOn(firebaseMock.db, "collection").mockImplementation((name: unknown) => name === "youtubeCache" ? { doc: () => ({ get: pending, set: pending }) } : originalCollection(name));
  global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ items: ["fresh"] }) }) as any;
  const result = youtubeJson("https://youtube.test/search?q=cache-stalled");
  await jest.advanceTimersByTimeAsync(1_000);
  expect(global.fetch).toHaveBeenCalledTimes(1);
  await jest.advanceTimersByTimeAsync(1_000);
  await expect(result).resolves.toEqual({ items: ["fresh"] });
});
