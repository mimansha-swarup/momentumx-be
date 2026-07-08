jest.mock("firebase-admin", () => ({
  apps: [],
  initializeApp: jest.fn(),
  credential: { cert: jest.fn() },
  firestore: Object.assign(jest.fn().mockReturnValue({}), {
    FieldValue: { serverTimestamp: jest.fn() },
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
      FieldValue: { serverTimestamp: jest.fn() },
      FieldPath: { documentId: jest.fn() },
    },
  },
}));

import ContextService from "../../src/service/context.service";
import UserRepository from "../../src/repository/user.repository";
import ContentRepository from "../../src/repository/content.repository";
import HooksRepository from "../../src/repository/hooks.repository";
import VideoProjectService from "../../src/service/video-project.service";
import { HttpError, Forbidden } from "../../src/utlils/errors";

jest.mock("../../src/repository/user.repository");
jest.mock("../../src/repository/content.repository");
jest.mock("../../src/repository/hooks.repository");
jest.mock("../../src/service/video-project.service");

const MockUserRepo = UserRepository as jest.MockedClass<typeof UserRepository>;
const MockContentRepo = ContentRepository as jest.MockedClass<typeof ContentRepository>;
const MockHooksRepo = HooksRepository as jest.MockedClass<typeof HooksRepository>;
const MockVpService = VideoProjectService as jest.MockedClass<typeof VideoProjectService>;

const USER_ID = "user-1";

const userDoc = {
  niche: "AI productivity",
  targetAudience: "solo founders",
  brandName: "MomentumX",
  website: "https://example.com",
  websiteContent: "About the brand...",
  description: "Channel about AI tools",
  userTitle: ["My best video", "Second best"],
  competitors: [
    { url: "https://youtube.com/@a", id: "chan-a", titles: ["A1", "A2"] },
    { url: "https://youtube.com/@b", id: "chan-b", titles: ["B1"] },
  ],
};

const fullProject = {
  id: "proj-1",
  createdBy: USER_ID,
  title: "Working title from project",
  topicId: "topic-1",
  scriptId: "script-1",
  hooksId: "hooks-1",
  selectedHookIndex: 1,
  packagingId: "pkg-1",
};

describe("ContextService.assemble — degradation matrix", () => {
  let service: ContextService;
  let userRepo: jest.Mocked<UserRepository>;
  let contentRepo: jest.Mocked<ContentRepository>;
  let hooksRepo: jest.Mocked<HooksRepository>;
  let vpService: jest.Mocked<VideoProjectService>;

  beforeEach(() => {
    userRepo = new MockUserRepo() as jest.Mocked<UserRepository>;
    contentRepo = new MockContentRepo() as jest.Mocked<ContentRepository>;
    hooksRepo = new MockHooksRepo() as jest.Mocked<HooksRepository>;
    vpService = new MockVpService(
      {} as never,
      {} as never,
      {} as never
    ) as jest.Mocked<VideoProjectService>;
    service = new ContextService(userRepo, contentRepo, hooksRepo, vpService);

    userRepo.get = jest.fn().mockResolvedValue(userDoc);
    vpService.getById = jest.fn().mockResolvedValue(fullProject);
    contentRepo.getTopic = jest.fn().mockResolvedValue({ id: "topic-1", title: "Topic title" });
    contentRepo.getScriptById = jest.fn().mockResolvedValue({ id: "script-1", script: "Full script text" });
    hooksRepo.findById = jest.fn().mockResolvedValue({ id: "hooks-1", hooks: ["Hook 0", "Hook 1", "Hook 2"] });
  });

  it("full context: project with script + selected hook + packaging", async () => {
    const ctx = await service.assemble(USER_ID, { videoProjectId: "proj-1" });

    expect(ctx.channelContext).toEqual({
      format: "talking_head",
      niche: "AI productivity",
      targetAudience: "solo founders",
      brandName: "MomentumX",
      website: "https://example.com",
      websiteContent: "About the brand...",
      channelDescription: "Channel about AI tools",
      topTitles: ["My best video", "Second best"],
      competitorUrls: ["https://youtube.com/@a", "https://youtube.com/@b"],
      competitorTitles: ["A1", "A2", "B1"],
    });
    expect(ctx.sessionContext).toEqual({
      videoProjectId: "proj-1",
      topicId: "topic-1",
      workingTitle: "Topic title",
      script: "Full script text",
      selectedHook: "Hook 1",
      packagingId: "pkg-1",
    });
  });

  it("prefers channelDescription over the legacy description field (3.5)", async () => {
    userRepo.get = jest.fn().mockResolvedValue({
      ...userDoc,
      description: "User's own blurb", // now the user-submitted description
      channelDescription: "The real channel description",
    });

    const ctx = await service.assemble(USER_ID, {});
    expect(ctx.channelContext.channelDescription).toBe(
      "The real channel description"
    );
  });

  it("script only: no hook selected yet → selectedHook null", async () => {
    vpService.getById = jest.fn().mockResolvedValue({
      ...fullProject,
      hooksId: null,
      selectedHookIndex: null,
      packagingId: null,
    });

    const ctx = await service.assemble(USER_ID, { videoProjectId: "proj-1" });

    expect(ctx.sessionContext.script).toBe("Full script text");
    expect(ctx.sessionContext.selectedHook).toBeNull();
    expect(ctx.sessionContext.packagingId).toBeNull();
    expect(hooksRepo.findById).not.toHaveBeenCalled();
  });

  it("title only: no script yet → script null, working title present", async () => {
    vpService.getById = jest.fn().mockResolvedValue({
      ...fullProject,
      scriptId: null,
      hooksId: null,
      selectedHookIndex: null,
      packagingId: null,
    });

    const ctx = await service.assemble(USER_ID, { videoProjectId: "proj-1" });

    expect(ctx.sessionContext.workingTitle).toBe("Topic title");
    expect(ctx.sessionContext.script).toBeNull();
    expect(ctx.sessionContext.selectedHook).toBeNull();
    expect(contentRepo.getScriptById).not.toHaveBeenCalled();
  });

  it("no project: channel context only, empty session", async () => {
    const ctx = await service.assemble(USER_ID);

    expect(ctx.channelContext.niche).toBe("AI productivity");
    expect(ctx.sessionContext).toEqual({
      videoProjectId: null,
      topicId: null,
      workingTitle: null,
      script: null,
      selectedHook: null,
      packagingId: null,
    });
    expect(vpService.getById).not.toHaveBeenCalled();
  });

  it("missing topic doc degrades workingTitle to the project title", async () => {
    contentRepo.getTopic = jest.fn().mockResolvedValue(undefined);

    const ctx = await service.assemble(USER_ID, { videoProjectId: "proj-1" });

    expect(ctx.sessionContext.workingTitle).toBe("Working title from project");
  });

  it("missing script doc degrades to null (dangling scriptId)", async () => {
    contentRepo.getScriptById = jest.fn().mockResolvedValue(null);

    const ctx = await service.assemble(USER_ID, { videoProjectId: "proj-1" });

    expect(ctx.sessionContext.script).toBeNull();
  });

  it("sparse user doc yields nulls/empties, never throws", async () => {
    userRepo.get = jest.fn().mockResolvedValue({ niche: "finance" });

    const ctx = await service.assemble(USER_ID);

    expect(ctx.channelContext.niche).toBe("finance");
    expect(ctx.channelContext.brandName).toBeNull();
    expect(ctx.channelContext.topTitles).toEqual([]);
    expect(ctx.channelContext.competitorUrls).toEqual([]);
    expect(ctx.channelContext.competitorTitles).toEqual([]);
    expect(ctx.channelContext.format).toBe("talking_head");
  });

  it("respects a stored faceless format; unknown values default to talking_head", async () => {
    userRepo.get = jest.fn().mockResolvedValue({ ...userDoc, format: "faceless" });
    expect((await service.assemble(USER_ID)).channelContext.format).toBe("faceless");

    userRepo.get = jest.fn().mockResolvedValue({ ...userDoc, format: "cinematic" });
    expect((await service.assemble(USER_ID)).channelContext.format).toBe("talking_head");
  });

  describe("overrides (pre-persist onboarding context)", () => {
    it("merges defined override keys over stored values", async () => {
      const ctx = await service.assemble(USER_ID, {
        overrides: { niche: "crypto", targetAudience: undefined },
      });

      expect(ctx.channelContext.niche).toBe("crypto");
      // undefined override must NOT clobber the stored value
      expect(ctx.channelContext.targetAudience).toBe("solo founders");
    });

    it("works with no user doc at all when overrides are supplied", async () => {
      userRepo.get = jest.fn().mockResolvedValue(undefined);

      const ctx = await service.assemble(USER_ID, {
        overrides: { niche: "crypto", topTitles: ["Pulled title"] },
      });

      expect(ctx.channelContext.niche).toBe("crypto");
      expect(ctx.channelContext.topTitles).toEqual(["Pulled title"]);
      expect(ctx.channelContext.brandName).toBeNull();
    });
  });

  describe("failure modes that must still throw", () => {
    it("404 when user doc missing and no overrides", async () => {
      userRepo.get = jest.fn().mockResolvedValue(undefined);

      await expect(service.assemble(USER_ID)).rejects.toMatchObject({
        statusCode: 404,
      });
    });

    it("propagates Forbidden from a foreign project id", async () => {
      vpService.getById = jest.fn().mockRejectedValue(Forbidden());

      await expect(
        service.assemble(USER_ID, { videoProjectId: "proj-1" })
      ).rejects.toBeInstanceOf(HttpError);
      await expect(
        service.assemble(USER_ID, { videoProjectId: "proj-1" })
      ).rejects.toMatchObject({ statusCode: 403 });
    });

    it("propagates repository errors (no silent degraded context)", async () => {
      contentRepo.getScriptById = jest
        .fn()
        .mockRejectedValue(new Error("Firestore unavailable"));

      await expect(
        service.assemble(USER_ID, { videoProjectId: "proj-1" })
      ).rejects.toThrow("Firestore unavailable");
    });
  });
});
