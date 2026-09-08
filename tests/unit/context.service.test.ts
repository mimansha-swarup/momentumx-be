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
import { testOwner, fakeAccountRepo, TEST_ACCOUNT_ID, OTHER_ACCOUNT_ID } from "../helpers/account";

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
  channelDescription: "Channel about AI tools",
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
  ideaId: "idea-1",
  scriptId: "script-1",
  hooksId: "hooks-1",
  selectedHookIndex: 1,
  packagingId: "pkg-1",
};

/**
 * The channel, from the ACCOUNT (Phase 06b). These suites used to stub
 * `userRepo.get` for this — the same record that holds identity — which is
 * exactly the conflation the phase removed: one record cannot answer for two
 * channels.
 */
const accountRepo = {
  getContext: jest.fn(),
  // Parameters declared so `mock.calls[n][1]` is the patch, not `never`.
  writeContext: jest.fn(async (_accountId: string, _patch: Record<string, unknown>) => undefined),
  // Reached by `forbidCrossAccount` when a linked resource belongs elsewhere.
  // Null = "the caller is not a member of that channel", so the refusal is
  // `account_forbidden` rather than an offer to switch.
  findById: jest.fn(async (_accountId: string) => null as Record<string, unknown> | null),
};
const channelRepo = () => accountRepo as never;

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
      {} as never,
      {} as never,
      {} as never
    ) as jest.Mocked<VideoProjectService>;
    service = new ContextService(channelRepo(), contentRepo, hooksRepo, vpService);

    accountRepo.getContext.mockResolvedValue(userDoc);
    vpService.getById = jest.fn().mockResolvedValue(fullProject);
    contentRepo.getIdea = jest.fn().mockResolvedValue({ id: "idea-1", title: "Idea title", accountId: TEST_ACCOUNT_ID });
    contentRepo.getScriptById = jest.fn().mockResolvedValue({ id: "script-1", script: "Full script text", accountId: TEST_ACCOUNT_ID });
    hooksRepo.findById = jest.fn().mockResolvedValue({ id: "hooks-1", hooks: ["Hook 0", "Hook 1", "Hook 2"], accountId: TEST_ACCOUNT_ID });
  });

  it("full context: project with script + selected hook + packaging", async () => {
    const ctx = await service.assemble(testOwner(USER_ID), { videoProjectId: "proj-1" });

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
      ideaId: "idea-1",
      workingTitle: "Idea title",
      script: "Full script text",
      selectedHook: "Hook 1",
      packagingId: "pkg-1",
    });
  });

  it("script only: no hook selected yet → selectedHook null", async () => {
    vpService.getById = jest.fn().mockResolvedValue({
      ...fullProject,
      hooksId: null,
      selectedHookIndex: null,
      packagingId: null,
    });

    const ctx = await service.assemble(testOwner(USER_ID), { videoProjectId: "proj-1" });

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

    const ctx = await service.assemble(testOwner(USER_ID), { videoProjectId: "proj-1" });

    expect(ctx.sessionContext.workingTitle).toBe("Idea title");
    expect(ctx.sessionContext.script).toBeNull();
    expect(ctx.sessionContext.selectedHook).toBeNull();
    expect(contentRepo.getScriptById).not.toHaveBeenCalled();
  });

  it("no project: channel context only, empty session", async () => {
    const ctx = await service.assemble(testOwner(USER_ID));

    expect(ctx.channelContext.niche).toBe("AI productivity");
    expect(ctx.sessionContext).toEqual({
      videoProjectId: null,
      ideaId: null,
      workingTitle: null,
      script: null,
      selectedHook: null,
      packagingId: null,
    });
    expect(vpService.getById).not.toHaveBeenCalled();
  });

  it("missing idea doc degrades workingTitle to the project title", async () => {
    contentRepo.getIdea = jest.fn().mockResolvedValue(undefined);

    const ctx = await service.assemble(testOwner(USER_ID), { videoProjectId: "proj-1" });

    expect(ctx.sessionContext.workingTitle).toBe("Working title from project");
  });

  it("missing script doc degrades to null (dangling scriptId)", async () => {
    contentRepo.getScriptById = jest.fn().mockResolvedValue(null);

    const ctx = await service.assemble(testOwner(USER_ID), { videoProjectId: "proj-1" });

    expect(ctx.sessionContext.script).toBeNull();
  });

  it("dangling hooksId (batch not found) degrades selectedHook to null", async () => {
    hooksRepo.findById = jest.fn().mockResolvedValue(null);

    const ctx = await service.assemble(testOwner(USER_ID), { videoProjectId: "proj-1" });

    expect(ctx.sessionContext.selectedHook).toBeNull();
  });

  it("selectedHookIndex out of range degrades selectedHook to null", async () => {
    // Project selects index 1, but the stored batch has fewer hooks.
    hooksRepo.findById = jest.fn().mockResolvedValue({ id: "hooks-1", hooks: [], accountId: TEST_ACCOUNT_ID });

    const ctx = await service.assemble(testOwner(USER_ID), { videoProjectId: "proj-1" });

    expect(ctx.sessionContext.selectedHook).toBeNull();
  });

  /**
   * The gap Phase 06 recorded as closed and was not.
   *
   * These three resolvers fetch by an id taken off the project document, so
   * nothing here is reachable from a request body — which is why the check was
   * skipped. But this is the last read before the model: a pointer at another
   * channel's document would have been read and pasted into the prompt, and the
   * result is Phase 06b's exact failure — documents tagged correctly, the CONTENT
   * belonging to a different channel, no error and no failing test.
   *
   * A foreign resource THROWS rather than degrading to null. Degrading would make
   * it indistinguishable from "no script yet" and would generate quietly from a
   * silently emptier context.
   */
  describe("a linked resource from another channel is refused, not read", () => {
    const foreign = { accountId: OTHER_ACCOUNT_ID };

    it("refuses an idea belonging to another channel", async () => {
      contentRepo.getIdea = jest
        .fn()
        .mockResolvedValue({ id: "idea-x", title: "Their idea", ...foreign });

      const err = await service
        .assemble(testOwner(USER_ID), { videoProjectId: "proj-1" })
        .catch((e) => e);

      expect(err).toMatchObject({ statusCode: 403, code: "account_forbidden" });
    });

    it("refuses a script belonging to another channel, rather than putting it in the prompt", async () => {
      contentRepo.getScriptById = jest
        .fn()
        .mockResolvedValue({ id: "script-x", script: "Their script text", ...foreign });

      const err = await service
        .assemble(testOwner(USER_ID), { videoProjectId: "proj-1" })
        .catch((e) => e);

      // `code`, not just the status: an undifferentiated 403 is read by the
      // client as account_forbidden and ejects the user. This suite's stub does
      // not know the foreign channel, so account_forbidden is the right answer
      // here — the wrong_account half is covered in cross-account.behaviour.
      expect(err).toMatchObject({ statusCode: 403, code: "account_forbidden" });
      // NOT `expect(err.message).not.toContain(...)` — the message is a fixed
      // literal, so that assertion could never fail and read as proof.
      expect(err.detail).toBeUndefined();
    });

    it("refuses a hook batch belonging to another channel", async () => {
      hooksRepo.findById = jest
        .fn()
        .mockResolvedValue({ id: "hooks-x", hooks: ["Their hook"], ...foreign });

      const err = await service
        .assemble(testOwner(USER_ID), { videoProjectId: "proj-1" })
        .catch((e) => e);

      expect(err).toMatchObject({ statusCode: 403, code: "account_forbidden" });
    });

    it("refuses an untagged legacy resource too — fail closed, not open", async () => {
      // No `accountId` at all. Phase 06's rule is that a document written before
      // the tenancy flip is refused rather than admitted.
      contentRepo.getScriptById = jest
        .fn()
        .mockResolvedValue({ id: "script-legacy", script: "Old script" });

      const err = await service
        .assemble(testOwner(USER_ID), { videoProjectId: "proj-1" })
        .catch((e) => e);

      expect(err).toMatchObject({ statusCode: 403, code: "account_forbidden" });
    });
  });

  it("sparse user doc yields nulls/empties, never throws", async () => {
    accountRepo.getContext.mockResolvedValue({ niche: "finance" });

    const ctx = await service.assemble(testOwner(USER_ID));

    expect(ctx.channelContext.niche).toBe("finance");
    expect(ctx.channelContext.brandName).toBeNull();
    expect(ctx.channelContext.topTitles).toEqual([]);
    expect(ctx.channelContext.competitorUrls).toEqual([]);
    expect(ctx.channelContext.competitorTitles).toEqual([]);
    expect(ctx.channelContext.format).toBe("talking_head");
  });

  it("competitor mapping tolerates malformed entries (missing url/titles)", async () => {
    accountRepo.getContext.mockResolvedValue({
      ...userDoc,
      competitors: [
        { url: "https://youtube.com/@a", titles: ["A1", "A2"] },
        { id: "no-url-here" }, // no url → dropped from urls; no titles → contributes none
        { url: "https://youtube.com/@c" }, // url but no titles
      ],
    });

    const { channelContext } = await service.assemble(testOwner(USER_ID));

    expect(channelContext.competitorUrls).toEqual([
      "https://youtube.com/@a",
      "https://youtube.com/@c",
    ]);
    expect(channelContext.competitorTitles).toEqual(["A1", "A2"]);
  });

  it("non-array competitors field degrades to empty lists", async () => {
    accountRepo.getContext.mockResolvedValue({ ...userDoc, competitors: "oops" });

    const { channelContext } = await service.assemble(testOwner(USER_ID));

    expect(channelContext.competitorUrls).toEqual([]);
    expect(channelContext.competitorTitles).toEqual([]);
  });

  it("respects a stored faceless format; unknown values default to talking_head", async () => {
    accountRepo.getContext.mockResolvedValue({ ...userDoc, format: "faceless" });
    expect((await service.assemble(testOwner(USER_ID))).channelContext.format).toBe("faceless");

    accountRepo.getContext.mockResolvedValue({ ...userDoc, format: "cinematic" });
    expect((await service.assemble(testOwner(USER_ID))).channelContext.format).toBe("talking_head");
  });

  describe("overrides (pre-persist onboarding context)", () => {
    it("merges defined override keys over stored values", async () => {
      const ctx = await service.assemble(testOwner(USER_ID), {
        overrides: { niche: "crypto", targetAudience: undefined },
      });

      expect(ctx.channelContext.niche).toBe("crypto");
      // undefined override must NOT clobber the stored value
      expect(ctx.channelContext.targetAudience).toBe("solo founders");
    });

    it("works with no user doc at all when overrides are supplied", async () => {
      accountRepo.getContext.mockResolvedValue(undefined);

      const ctx = await service.assemble(testOwner(USER_ID), {
        overrides: { niche: "crypto", topTitles: ["Pulled title"] },
      });

      expect(ctx.channelContext.niche).toBe("crypto");
      expect(ctx.channelContext.topTitles).toEqual(["Pulled title"]);
      expect(ctx.channelContext.brandName).toBeNull();
    });
  });

  describe("failure modes that must still throw", () => {
    it("404 when user doc missing and no overrides", async () => {
      accountRepo.getContext.mockResolvedValue(undefined);

      await expect(service.assemble(testOwner(USER_ID))).rejects.toMatchObject({
        statusCode: 404,
      });
    });

    it("propagates Forbidden from a foreign project id", async () => {
      vpService.getById = jest.fn().mockRejectedValue(Forbidden());

      await expect(
        service.assemble(testOwner(USER_ID), { videoProjectId: "proj-1" })
      ).rejects.toBeInstanceOf(HttpError);
      await expect(
        service.assemble(testOwner(USER_ID), { videoProjectId: "proj-1" })
      ).rejects.toMatchObject({ statusCode: 403 });
    });

    it("propagates repository errors (no silent degraded context)", async () => {
      contentRepo.getScriptById = jest
        .fn()
        .mockRejectedValue(new Error("Firestore unavailable"));

      await expect(
        service.assemble(testOwner(USER_ID), { videoProjectId: "proj-1" })
      ).rejects.toThrow("Firestore unavailable");
    });
  });
});
