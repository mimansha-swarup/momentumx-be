// Regenerating ideas — the flow, not the code.
//
// Contract taken from docs/product/pipeline-spec.md and .claude/rules/api-design.md:
//   - POST /v1/ideas/generate      is ADDITIVE. It must NOT archive.
//   - POST /v1/ideas/regenerate-all archives the batch, then generates a new one.
//   - An idea can back MORE THAN ONE video project. When its content changes,
//     every project built on it goes stale — via the project index, not
//     idea.videoProjectId, which reaches only one of them.
//
// That fan-out is the part a user actually feels: regenerate your ideas, and a
// second project sitting on the same idea must stop presenting its old script and
// packaging as current. It had no test at any level — `cascadeIdeaStale`,
// `regenerateAll` and `regenerateOne` were never invoked by the suite. The route
// test mocks ContentService wholesale, so it only proved the HTTP shell.

jest.mock("firebase-admin", () => ({
  apps: [],
  initializeApp: jest.fn(),
  credential: { cert: jest.fn() },
  firestore: Object.assign(jest.fn().mockReturnValue({}), {
    FieldValue: { serverTimestamp: jest.fn(), increment: jest.fn((n: number) => ({ __increment: n })) },
    FieldPath: { documentId: jest.fn() },
    Timestamp: { now: jest.fn() },
  }),
  auth: jest.fn().mockReturnValue({ verifyIdToken: jest.fn() }),
}));

jest.mock("../../../src/config/firebase", () => ({
  db: {},
  auth: {},
  firebase: {
    firestore: {
      FieldValue: { serverTimestamp: jest.fn(), increment: jest.fn((n: number) => ({ __increment: n })) },
      FieldPath: { documentId: jest.fn() },
    },
  },
}));

jest.mock("../../../src/utlils/ai", () => ({
  collectJson: jest.requireActual("../../../src/utlils/ai").collectJson,
  generateContent: jest.fn(),
  generateStreamingContent: jest.fn(),
}));

// assertOwner stays REAL — an earlier suite hand-wrote a copy of it here and the
// 401 assertion then proved nothing about production.
jest.mock("../../../src/utlils/content", () => ({
  ...jest.requireActual("../../../src/utlils/content"),
  getClusteredTitles: jest.fn().mockResolvedValue([]),
  formatCreatorsData: jest.fn().mockReturnValue("creators-data"),
  formatGeneratedIdea: jest.fn(async (idea, userId, batchId) => ({
    id: "idea-new",
    title: idea.workingTitle,
    concept: idea.concept,
    ideaType: idea.type,
    evidence: idea.evidence ?? null,
    embedding: [0.1],
    createdBy: userId,
    batchId: batchId ?? null,
  })),
}));

import ContentService from "../../../src/service/content.service";
import ContentRepository from "../../../src/repository/content.repository";
import UserRepository from "../../../src/repository/user.repository";
import VideoProjectService from "../../../src/service/video-project.service";
import ResearchContextService from "../../../src/service/research-context.service";
import { generateContent } from "../../../src/utlils/ai";
import { formatGeneratedIdea } from "../../../src/utlils/content";
import { makeTestAccountService, testOwner, OTHER_ACCOUNT_ID, TEST_ACCOUNT_ID, fakeAccountRepo } from "../../helpers/account";

jest.mock("../../../src/repository/content.repository");
jest.mock("../../../src/repository/user.repository");
jest.mock("../../../src/service/research-context.service");

const mockGenerate = generateContent as jest.MockedFunction<typeof generateContent>;
const mockFormat = formatGeneratedIdea as jest.MockedFunction<typeof formatGeneratedIdea>;

const IDEAS = [
  { concept: "Concept one about a niche pain point", workingTitle: "Fresh long idea", type: "long", evidence: "trending signal" },
  { concept: "Concept two, one point for Shorts", workingTitle: "Fresh short idea", type: "short", evidence: "" },
];

const makeStream = (payload: unknown) =>
  ({
    stream: (async function* () {
      yield { text: () => JSON.stringify(payload) };
    })(),
  }) as never;

describe("Regenerate All — the batch is replaced and every project built on it goes stale", () => {
  let service: ContentService;
  let repo: jest.Mocked<ContentRepository>;
  let userRepo: jest.Mocked<UserRepository>;
  let vpService: jest.Mocked<VideoProjectService>;
  let calls: string[];

  beforeEach(() => {
    calls = [];
    repo = new (ContentRepository as jest.MockedClass<typeof ContentRepository>)() as jest.Mocked<ContentRepository>;
    userRepo = new (UserRepository as jest.MockedClass<typeof UserRepository>)() as jest.Mocked<UserRepository>;
    const researchContext = new (ResearchContextService as jest.MockedClass<typeof ResearchContextService>)(
      {} as never
    ) as jest.Mocked<ResearchContextService>;
    researchContext.getIdeaSignals = jest.fn().mockResolvedValue("signals");

    userRepo.get = jest.fn().mockResolvedValue({
      niche: "AI tools", brandName: "MomentumX", targetAudience: "creators",
      website: "", websiteContent: "", competitors: [],
    });
    userRepo.update = jest.fn().mockResolvedValue(undefined);

    repo.getActiveBatch = jest.fn().mockResolvedValue([{ id: "idea-a" }, { id: "idea-b" }]);
    repo.archiveUserIdeas = jest.fn().mockImplementation(async () => { calls.push("archive"); });
    repo.batchSaveIdeas = jest.fn().mockImplementation(async (ideas) => ideas);
    repo.getIdea = jest.fn();
    repo.updateIdea = jest.fn().mockResolvedValue(undefined);

    vpService = {
      getProjectsByIdea: jest.fn().mockImplementation(async () => { calls.push("lookup"); return []; }),
      markStale: jest.fn().mockImplementation(async () => { calls.push("markStale"); }),
      markPackagingDocumentStale: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<VideoProjectService>;

    mockGenerate.mockImplementation(async () => makeStream(IDEAS));
    // Re-seeded per test, not just at module scope: `clearMocks: true` runs
    // mockClear, which wipes call history but LEAVES the implementation — so the
    // mockRejectedValue set by the 503 test below would otherwise leak forward
    // into every test after it.
    mockFormat.mockImplementation((async (
      idea: { workingTitle: string; concept: string; type: string },
      userId: string,
      batchId?: string
    ) => ({
      id: "idea-new", title: idea.workingTitle, concept: idea.concept, ideaType: idea.type,
      evidence: null, embedding: [0.1], createdBy: userId, batchId: batchId ?? null,
    })) as never);
    service = new ContentService(repo, userRepo, vpService as never, fakeAccountRepo(), researchContext);
  });

  it("stales EVERY project backed by an archived idea, not just one per idea", async () => {
    // The whole point of the fan-out: idea-a backs two projects.
    vpService.getProjectsByIdea = jest.fn(async (ideaId: string) =>
      ideaId === "idea-a" ? [{ id: "proj-1" }, { id: "proj-2" }] : [{ id: "proj-3" }]
    ) as never;

    await service.regenerateAll(testOwner("user-1"));

    expect(vpService.markStale.mock.calls.map((c) => c[0]).sort()).toEqual([
      "proj-1", "proj-2", "proj-3",
    ]);
    // Every staled project's packaging doc is staled too, or the packaging screen
    // keeps showing a title written for an idea that no longer exists.
    expect(vpService.markPackagingDocumentStale).toHaveBeenCalledTimes(3);
    expect(vpService.markStale).toHaveBeenCalledWith("proj-1", "research");
  });

  it("looks the projects up BEFORE archiving — afterwards the batch is gone", async () => {
    vpService.getProjectsByIdea = jest.fn(async () => { calls.push("lookup"); return [{ id: "p" }]; }) as never;

    await service.regenerateAll(testOwner("user-1"));

    expect(calls.indexOf("archive")).toBeGreaterThan(calls.lastIndexOf("lookup"));
  });

  it("archives the old batch and saves a new one", async () => {
    const saved = await service.regenerateAll(testOwner("user-1"));

    expect(repo.archiveUserIdeas).toHaveBeenCalledWith(TEST_ACCOUNT_ID);
    expect(saved).toHaveLength(2);
    expect(repo.batchSaveIdeas).toHaveBeenCalled();
  });

  it("shares ONE batchId across the new slate, so it reads as a single batch", async () => {
    await service.regenerateAll(testOwner("user-1"));

    const batchIds = mockFormat.mock.calls.map((c) => c[2]);
    expect(new Set(batchIds).size).toBe(1);
    expect(batchIds[0]).toBeTruthy();
  });

  it("503s rather than returning an empty slate — the old batch is already gone", async () => {
    mockFormat.mockRejectedValue(new Error("embedding service down"));

    const err = await service.regenerateAll(testOwner("user-1")).catch((e) => e);

    expect(err.statusCode).toBe(503);
    // Silent data loss is the failure being prevented: archived, nothing back,
    // and a 200 telling the user everything is fine.
    expect(err.message).toMatch(/Couldn't regenerate/);
  });

  it("still regenerates when the stale cascade fails — the cascade is bookkeeping, not a gate", async () => {
    vpService.getProjectsByIdea = jest.fn().mockRejectedValue(new Error("index unavailable")) as never;

    const saved = await service.regenerateAll(testOwner("user-1"));

    expect(saved).toHaveLength(2);
    expect(repo.archiveUserIdeas).toHaveBeenCalled();
  });

  it("survives one project failing to stale and keeps cascading to the rest", async () => {
    vpService.getProjectsByIdea = jest.fn(async () => [{ id: "proj-1" }, { id: "proj-2" }]) as never;
    vpService.markStale = jest
      .fn()
      .mockRejectedValueOnce(new Error("write conflict"))
      .mockResolvedValue(undefined) as never;

    const saved = await service.regenerateAll(testOwner("user-1"));

    expect(vpService.markStale).toHaveBeenCalledTimes(4); // 2 ideas × 2 projects
    expect(saved).toHaveLength(2);
  });

  it("refuses an unauthenticated caller BEFORE destroying the batch", async () => {
    const err = await service.regenerateAll(testOwner("")).catch((e) => e);

    expect(err.statusCode).toBe(401);
    expect(repo.archiveUserIdeas).not.toHaveBeenCalled();
  });

  // The contract "Generate More is additive" is non-negotiable in api-design.md —
  // the missing archive call there is deliberate and gets "fixed" by mistake.
  it("is the ONLY idea path that archives — plain generation is additive", async () => {
    await service.generateIdeas(testOwner("user-1"));
    expect(repo.archiveUserIdeas).not.toHaveBeenCalled();

    await service.regenerateAll(testOwner("user-1"));
    expect(repo.archiveUserIdeas).toHaveBeenCalledTimes(1);
  });
});

describe("Regenerate one slot — the slot is replaced in place", () => {
  let service: ContentService;
  let repo: jest.Mocked<ContentRepository>;
  let userRepo: jest.Mocked<UserRepository>;
  let vpService: jest.Mocked<VideoProjectService>;

  const IDEA = {
    id: "idea-1", createdBy: "user-1", accountId: TEST_ACCOUNT_ID, ideaType: "short",
    batchId: "batch-7", isScriptGenerated: true, videoProjectId: "proj-1",
  };

  beforeEach(() => {
    repo = new (ContentRepository as jest.MockedClass<typeof ContentRepository>)() as jest.Mocked<ContentRepository>;
    userRepo = new (UserRepository as jest.MockedClass<typeof UserRepository>)() as jest.Mocked<UserRepository>;
    const researchContext = new (ResearchContextService as jest.MockedClass<typeof ResearchContextService>)(
      {} as never
    ) as jest.Mocked<ResearchContextService>;
    researchContext.getIdeaSignals = jest.fn().mockResolvedValue("signals");

    userRepo.get = jest.fn().mockResolvedValue({
      niche: "AI tools", brandName: "MomentumX", targetAudience: "creators",
      website: "", websiteContent: "", competitors: [],
    });
    userRepo.update = jest.fn().mockResolvedValue(undefined);
    repo.getIdea = jest.fn().mockResolvedValue(IDEA);
    repo.updateIdea = jest.fn().mockResolvedValue(undefined);
    repo.archiveUserIdeas = jest.fn().mockResolvedValue(undefined);

    vpService = {
      getProjectsByIdea: jest.fn().mockResolvedValue([{ id: "proj-1" }, { id: "proj-2" }]),
      markStale: jest.fn().mockResolvedValue(undefined),
      markPackagingDocumentStale: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<VideoProjectService>;

    mockFormat.mockImplementation((async (idea: { workingTitle: string; concept: string; type: string }, userId: string, batchId?: string) => ({
      id: "idea-new", title: idea.workingTitle, concept: idea.concept, ideaType: idea.type,
      evidence: null, embedding: [0.1], createdBy: userId, batchId: batchId ?? null,
    })) as never);
    mockGenerate.mockImplementation(async () => makeStream(IDEAS));
    service = new ContentService(repo, userRepo, vpService as never, fakeAccountRepo(), researchContext);
  });

  it("404s an unknown idea and 403s someone else's, without generating", async () => {
    repo.getIdea = jest.fn().mockResolvedValue(null);
    expect((await service.regenerateOne(testOwner("user-1"), "nope").catch((e) => e)).statusCode).toBe(404);

    repo.getIdea = jest.fn().mockResolvedValue({ ...IDEA, createdBy: "someone-else", accountId: OTHER_ACCOUNT_ID });
    expect((await service.regenerateOne(testOwner("user-1"), "idea-1").catch((e) => e)).statusCode).toBe(403);

    expect(repo.updateIdea).not.toHaveBeenCalled();
  });

  it("keeps the slot's format — a Shorts slot regenerates as Shorts", async () => {
    const result = await service.regenerateOne(testOwner("user-1"), "idea-1");

    expect(result.ideaType).toBe("short");
    expect(result.title).toBe("Fresh short idea");
  });

  it("falls back to the first idea when the model returns nothing of that format", async () => {
    mockGenerate.mockImplementation(async () => makeStream([IDEAS[0]])); // long only

    const result = await service.regenerateOne(testOwner("user-1"), "idea-1");

    expect(result.ideaType).toBe("long");
  });

  it("writes into the SAME document id — the slot moves, the list does not", async () => {
    const result = await service.regenerateOne(testOwner("user-1"), "idea-1");

    expect(repo.updateIdea).toHaveBeenCalledWith("idea-1", expect.any(Object));
    expect(result.id).toBe("idea-1");
  });

  it("clears the old idea's script link, so a fresh idea cannot claim a script written for the previous one", async () => {
    await service.regenerateOne(testOwner("user-1"), "idea-1");

    expect(repo.updateIdea.mock.calls[0][1]).toMatchObject({
      isScriptGenerated: false,
      videoProjectId: null,
      userFeedback: null,
    });
  });

  it("keeps the idea in its existing batch", async () => {
    await service.regenerateOne(testOwner("user-1"), "idea-1");

    expect(mockFormat.mock.calls[0][2]).toBe("batch-7");
  });

  it("counts exactly one idea toward stats, not a whole batch", async () => {
    await service.regenerateOne(testOwner("user-1"), "idea-1");

    const [, update] = userRepo.update.mock.calls.at(-1) as [string, Record<string, unknown>];
    expect(update["stats.ideas"]).toEqual({ __increment: 1 });
    // Regeneration must not also fire generateIdeas' batch-sized increment.
    expect(userRepo.update).toHaveBeenCalledTimes(1);
  });

  it("stales every project on this idea too — one slot changing is still a change", async () => {
    await service.regenerateOne(testOwner("user-1"), "idea-1");

    expect(vpService.markStale.mock.calls.map((c) => c[0])).toEqual(["proj-1", "proj-2"]);
  });

  it("refuses an unauthenticated caller before reading anything", async () => {
    const err = await service.regenerateOne(testOwner(""), "idea-1").catch((e) => e);

    expect(err.statusCode).toBe(401);
    expect(repo.getIdea).not.toHaveBeenCalled();
  });
});
