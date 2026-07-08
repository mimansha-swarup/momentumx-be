jest.mock("firebase-admin", () => ({
  apps: [],
  initializeApp: jest.fn(),
  credential: { cert: jest.fn() },
  firestore: Object.assign(jest.fn().mockReturnValue({}), {
    FieldValue: { serverTimestamp: jest.fn(), increment: jest.fn((n: number) => n) },
    FieldPath: { documentId: jest.fn() },
    Timestamp: { now: jest.fn() },
  }),
  auth: jest.fn().mockReturnValue({ verifyIdToken: jest.fn() }),
}));

jest.mock("../../src/config/firebase", () => ({
  db: {},
  auth: {},
  firebase: {
    firestore: {
      FieldValue: { serverTimestamp: jest.fn(), increment: jest.fn((n: number) => n) },
      FieldPath: { documentId: jest.fn() },
    },
  },
}));

jest.mock("../../src/utlils/ai", () => ({
  generateContent: jest.fn(),
  generateStreamingContent: jest.fn(),
}));

jest.mock("../../src/utlils/content", () => ({
  ...jest.requireActual("../../src/utlils/content"),
  getClusteredTitles: jest.fn().mockResolvedValue([]),
  formatCreatorsData: jest.fn().mockReturnValue("creators-data"),
  formatGeneratedIdea: jest.fn(async (idea, userId, batchId) => ({
    id: "topic-new",
    title: idea.workingTitle,
    concept: idea.concept,
    ideaType: idea.type,
    evidence: idea.evidence ?? null,
    embedding: [0.1],
    createdBy: userId,
    batchId: batchId ?? null,
  })),
}));

import ContentService from "../../src/service/content.service";
import ContentRepository from "../../src/repository/content.repository";
import UserRepository from "../../src/repository/user.repository";
import ResearchContextService from "../../src/service/research-context.service";
import { generateContent } from "../../src/utlils/ai";
import { formatCreatorsData } from "../../src/utlils/content";
import { IDEA_USER_PROMPT } from "../../src/constants/prompt";

jest.mock("../../src/repository/content.repository");
jest.mock("../../src/repository/user.repository");
jest.mock("../../src/service/research-context.service");

const MockContentRepo = ContentRepository as jest.MockedClass<typeof ContentRepository>;
const MockUserRepo = UserRepository as jest.MockedClass<typeof UserRepository>;
const MockResearchContext = ResearchContextService as jest.MockedClass<typeof ResearchContextService>;
const mockGenerate = generateContent as jest.MockedFunction<typeof generateContent>;

const IDEAS = [
  { concept: "Concept one about niche pain point", workingTitle: "Working title one", type: "long", evidence: "trending signal" },
  { concept: "Concept two, single point for Shorts", workingTitle: "Working title two", type: "short", evidence: "" },
];

function makeStream(payload: unknown) {
  return {
    stream: (async function* () {
      yield { text: () => JSON.stringify(payload) };
    })(),
  } as never;
}

describe("ContentService.generateIdeas", () => {
  let service: ContentService;
  let repo: jest.Mocked<ContentRepository>;
  let userRepo: jest.Mocked<UserRepository>;
  let researchContext: jest.Mocked<ResearchContextService>;

  beforeEach(() => {
    repo = new MockContentRepo() as jest.Mocked<ContentRepository>;
    userRepo = new MockUserRepo() as jest.Mocked<UserRepository>;
    researchContext = new MockResearchContext({} as never) as jest.Mocked<ResearchContextService>;
    userRepo.get = jest.fn().mockResolvedValue({
      niche: "AI tools",
      brandName: "MomentumX",
      targetAudience: "creators",
      website: "",
      websiteContent: "",
      competitors: [],
    });
    userRepo.update = jest.fn().mockResolvedValue(undefined);
    researchContext.getIdeaSignals = jest.fn().mockResolvedValue("Live research signals:\nSome trend — 1.2M views");
    // Fresh stream per call — an async generator is single-use.
    mockGenerate.mockImplementation(async () => makeStream(IDEAS));
    service = new ContentService(repo, userRepo, undefined, researchContext);
  });

  it("returns parsed idea objects and injects research signals into the prompt", async () => {
    const ideas = await service.generateIdeas("user-1");

    expect(ideas).toHaveLength(2);
    expect(ideas[0]).toMatchObject({ workingTitle: "Working title one", type: "long" });
    expect(researchContext.getIdeaSignals).toHaveBeenCalledWith("AI tools");

    const [, userPrompt] = mockGenerate.mock.calls[0];
    expect(userPrompt).toContain("Some trend — 1.2M views");
    expect(userPrompt).not.toMatch(/\{researchSignals\}/);
  });

  it("degrades cleanly when no research context service is wired", async () => {
    service = new ContentService(repo, userRepo);
    const ideas = await service.generateIdeas("user-1");

    expect(ideas).toHaveLength(2);
    const [, userPrompt] = mockGenerate.mock.calls[0];
    expect(userPrompt).not.toMatch(/\{researchSignals\}/);
  });

  it("filters malformed idea entries and throws when none survive", async () => {
    mockGenerate.mockImplementation(async () =>
      makeStream([{ concept: "", workingTitle: "" }, { bogus: true }])
    );

    await expect(service.generateIdeas("user-1")).rejects.toThrow(
      "Unable to generate ideas at the moment"
    );
  });

  it("increments stats.topics by batch size only when counting is on", async () => {
    await service.generateIdeas("user-1");
    expect(userRepo.update).toHaveBeenCalledWith("user-1", {
      "stats.topics": 2,
    });

    userRepo.update.mockClear();
    await service.generateIdeas("user-1", false);
    expect(userRepo.update).not.toHaveBeenCalled();
  });

  it("404s when the user record is missing", async () => {
    userRepo.get = jest.fn().mockResolvedValue(undefined);
    await expect(service.generateIdeas("user-1")).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it("merges a not-yet-persisted override context over the record (instant-first-idea)", async () => {
    const ideas = await service.generateIdeas("user-1", true, {
      niche: "Personal finance",
      targetAudience: "young professionals",
      brandName: "Wealth With Sam",
      topTitles: ["How to budget", "Index funds 101"],
    });

    expect(ideas).toHaveLength(2);
    // Research + prompt use the override niche, not the persisted "AI tools".
    expect(researchContext.getIdeaSignals).toHaveBeenCalledWith("Personal finance");
    const userPrompt = mockGenerate.mock.calls[0][1] as string;
    expect(userPrompt).toContain("Personal finance");
    expect(userPrompt).toContain("young professionals");
    expect(userPrompt).toContain("Wealth With Sam");
    // Channel titles ride into the creators-data block via userTitle (override
    // mapped onto the ctx passed to formatCreatorsData).
    expect(formatCreatorsData).toHaveBeenCalledWith(
      expect.objectContaining({
        niche: "Personal finance",
        userTitle: ["How to budget", "Index funds 101"],
      }),
      expect.anything()
    );
  });

  it("generates from the override even when the user record is missing (pre-onboarding)", async () => {
    userRepo.get = jest.fn().mockResolvedValue(undefined);

    const ideas = await service.generateIdeas("user-1", true, {
      niche: "Personal finance",
    });

    expect(ideas).toHaveLength(2);
    expect(researchContext.getIdeaSignals).toHaveBeenCalledWith("Personal finance");
  });
});

describe("IDEA_USER_PROMPT placeholders", () => {
  it("has no unreplaced placeholders after full assembly", () => {
    const prompt = IDEA_USER_PROMPT
      .replace(/{niche}/g, "n")
      .replace("{website}", "w")
      .replace("{websiteContent}", "wc")
      .replace("{competitors}", "c")
      .replace("{targetAudience}", "a")
      .replace(/{userName}/g, "u")
      .replace("{researchSignals}", "");
    expect(prompt).not.toMatch(/\{[a-zA-Z][a-zA-Z0-9]*\}/);
  });
});
