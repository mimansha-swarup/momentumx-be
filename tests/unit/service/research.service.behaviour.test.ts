// ResearchService — the real class. It had never executed under test: the only
// suite that touched it (`tests/integration/research.route.behaviour.test.ts`)
// mocks the whole module at the boundary, so the documented "400 when query is
// missing or empty" was asserted against a rejection the test itself configured.
//
// Contract from docs/features/research/api.md and the /v1/research section of
// .claude/rules/api-design.md.

import { fakeAccountRepo, testOwner } from "../../helpers/account";
import ResearchService from "../../../src/service/research.service";
import ResearchRepository from "../../../src/repository/research.repository";
import UserRepository from "../../../src/repository/user.repository";
import { DEFAULT_NICHE } from "../../../src/constants/research";

const makeService = (
  user: Record<string, unknown> | null,
  repoOverrides: Partial<Record<string, jest.Mock>> = {}
) => {
  const repo = {
    getTrendingVideos: jest.fn().mockResolvedValue([]),
    getChannelTopVideos: jest.fn().mockResolvedValue([]),
    getKeywordSignals: jest.fn().mockResolvedValue([]),
    ...repoOverrides,
  } as unknown as jest.Mocked<ResearchRepository>;

  // The channel this research is for. Named `user` by the factory's callers
  // because that is where it used to live; it is the ACCOUNT's context now, and
  // that is the whole point — trending for the finance channel must not be
  // seeded with the cooking channel's niche.
  const accounts = {
    getContext: jest.fn().mockResolvedValue(user),
  } as never;

  return { service: new ResearchService(repo, accounts), repo, accounts };
};

/**
 * The channel, from the ACCOUNT (Phase 06b). These suites used to stub
 * `userRepo.get` for this — the same record that holds identity — which is
 * exactly the conflation the phase removed: one record cannot answer for two
 * channels.
 */
const accountRepo = {
  getContext: jest.fn(),
  writeContext: jest.fn(async () => undefined),
};
const channelRepo = () => accountRepo as never;

describe("getTrending — research is scoped to the creator's own niche", () => {
  it("searches the user's niche", async () => {
    const { service, repo } = makeService({ niche: "AI tools" });

    await service.getTrending(testOwner("user-1"));

    expect(repo.getTrendingVideos).toHaveBeenCalledWith("AI tools");
  });

  it("falls back to a default niche rather than searching for nothing", async () => {
    // A URL-only onboarding can leave `niche` unset. The fallback keeps the
    // panel populated — but it is someone else's niche shown unlabelled as
    // theirs, which is filed as an open FE/UX defect, not fixed here.
    const { service, repo } = makeService({ niche: "" });

    await service.getTrending(testOwner("user-1"));

    expect(repo.getTrendingVideos).toHaveBeenCalledWith(DEFAULT_NICHE);
  });

  it("falls back when the user record is missing entirely", async () => {
    const { service, repo } = makeService(null);

    await service.getTrending(testOwner("user-1"));

    expect(repo.getTrendingVideos).toHaveBeenCalledWith(DEFAULT_NICHE);
  });
});

describe("getCompetitorInsights — one slow competitor must not lose the others", () => {
  const COMPETITORS = [
    { id: "chan-1", url: "youtube.com/@one" },
    { id: "chan-2", url: "youtube.com/@two" },
  ];

  it("returns a row per competitor with its videos", async () => {
    const { service } = makeService(
      { competitors: COMPETITORS },
      { getChannelTopVideos: jest.fn().mockResolvedValue(["Video A"]) }
    );

    const result = await service.getCompetitorInsights(testOwner("user-1"));

    expect(result).toEqual([
      { channelTitle: "youtube.com/@one", titles: ["Video A"] },
      { channelTitle: "youtube.com/@two", titles: ["Video A"] },
    ]);
  });

  it("keeps a failed competitor as an empty row instead of failing the request", async () => {
    const { service } = makeService(
      { competitors: COMPETITORS },
      {
        getChannelTopVideos: jest
          .fn()
          .mockRejectedValueOnce(new Error("quota exceeded"))
          .mockResolvedValueOnce(["Video B"]),
      }
    );

    const result = await service.getCompetitorInsights(testOwner("user-1"));

    // Promise.allSettled, not Promise.all: one quota error must not blank the
    // whole competitors panel.
    expect(result).toEqual([
      { channelTitle: "youtube.com/@one", titles: [] },
      { channelTitle: "youtube.com/@two", titles: ["Video B"] },
    ]);
  });

  it("skips competitors whose channel id was never resolved, rather than querying undefined", async () => {
    const { service, repo } = makeService({
      competitors: [{ url: "youtube.com/@unresolved" }, ...COMPETITORS],
    });

    const result = await service.getCompetitorInsights(testOwner("user-1"));

    expect(repo.getChannelTopVideos).toHaveBeenCalledTimes(2);
    expect(result).toHaveLength(2);
    expect(result.map((r) => r.channelTitle)).not.toContain("youtube.com/@unresolved");
  });

  it("returns an empty list when no competitors are set", async () => {
    const { service, repo } = makeService({ competitors: [] });

    expect(await service.getCompetitorInsights(testOwner("user-1"))).toEqual([]);
    expect(repo.getChannelTopVideos).not.toHaveBeenCalled();
  });

  it("returns an empty list when the user record has no competitors field at all", async () => {
    const { service } = makeService({});

    expect(await service.getCompetitorInsights(testOwner("user-1"))).toEqual([]);
  });
});

describe("getKeywords — the documented 400", () => {
  it.each(["", "   ", undefined as unknown as string])(
    "rejects %p with 400 before spending a YouTube quota unit",
    async (query) => {
      const { service, repo } = makeService({});

      const err = await service.getKeywords(query).catch((e) => e);

      expect(err.statusCode).toBe(400);
      expect(err.message).toMatch(/query is required/);
      expect(repo.getKeywordSignals).not.toHaveBeenCalled();
    }
  );

  it("passes a real query through untouched", async () => {
    const { service, repo } = makeService({});

    await service.getKeywords("ai tools");

    expect(repo.getKeywordSignals).toHaveBeenCalledWith("ai tools");
  });
});
