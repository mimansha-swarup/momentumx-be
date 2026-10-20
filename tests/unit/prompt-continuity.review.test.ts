jest.mock("firebase-admin", () => ({
  apps: [],
  initializeApp: jest.fn(),
  credential: { cert: jest.fn() },
  firestore: Object.assign(jest.fn().mockReturnValue({}), {
    FieldValue: { serverTimestamp: jest.fn(), increment: jest.fn((n: number) => ({ _increment: n })) },
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
      FieldValue: { serverTimestamp: jest.fn(), increment: jest.fn((n: number) => ({ _increment: n })) },
      FieldPath: { documentId: jest.fn() },
    },
  },
}));

jest.mock("../../src/utlils/ai", () => ({
  // collectJson stays REAL: it is the empty/malformed-JSON guard, and the fake
  // streams below are exactly what should be driving it.
  collectJson: jest.requireActual("../../src/utlils/ai").collectJson,
  generateContent: jest.fn(),
  generateStreamingContent: jest.fn(),
  generateTextContent: jest.fn(),
}));

import ContentService from "../../src/service/content.service";
import { generateStreamingContent, generateTextContent } from "../../src/utlils/ai";
import { fakeAccountRepo, testOwner, TEST_ACCOUNT_ID, OTHER_ACCOUNT_ID } from "../helpers/account";
import { unmeteredSteps } from "../helpers/step-runner";
import { fillTemplate } from "../../src/utlils/prompt-blocks";

const ai = generateStreamingContent as jest.Mock;
const textAi = generateTextContent as jest.Mock;
const owner = testOwner("review-user");
const manuscript = "A supported explanation.\n\n[Pause]\n\n[On screen: Compare the options]\n\nChoose according to your needs.";
const idea = { accountId: TEST_ACCOUNT_ID, title: "Specific question", concept: "Compare tradeoffs {websiteContent} $&", ideaType: "short", evidence: "Supplied signal, not proof" };
function setup(linkedIdea: unknown = idea, linked = true) {
  const repo = {
    getIdea: jest.fn().mockResolvedValue(linkedIdea),
    getScriptById: jest.fn().mockResolvedValue({ accountId: TEST_ACCOUNT_ID, title: "Legacy title", ...(linked ? { ideaId: "i" } : {}) }),
    editScript: jest.fn(), saveScript: jest.fn(), updateIdea: jest.fn(),
  };
  const projects = { getById: jest.fn().mockResolvedValue({ id: "p", ideaId: "i", scriptId: null }), completeStep: jest.fn(), linkResource: jest.fn() };
  const accounts = fakeAccountRepo({ brandName: "Quiet Brand", niche: "decision making", targetAudience: "beginners", websiteContent: "PROFILE_SENTINEL", format: "faceless" });
  const service = new ContentService(repo as any, { update: jest.fn().mockResolvedValue(undefined) } as any, projects as any, accounts, undefined, unmeteredSteps);
  return { service, repo };
}
beforeEach(() => {
  ai.mockReset();
  textAi.mockReset();
  textAi.mockResolvedValue({ response: { text: () => manuscript, candidates: [{ finishReason: "STOP" }] } });
  ai.mockImplementation(async () => ({ stream: (async function* () { yield { text: () => manuscript }; })() }));
});

it("one-pass insertion never resolves placeholders introduced by source values", () => {
  expect(fillTemplate("{script}|{brand}", { "{script}": "{brand} $& $$", "{brand}": "Acme" })).toBe("{brand} $& $$|Acme");
});
it.each(["initial", "regenerate"])("%s script receives full idea without interpreting its text and preserves cues", async mode => {
  const { service, repo } = setup();
  if (mode === "initial") {
    const res = { setHeader: jest.fn(), flushHeaders: jest.fn(), write: jest.fn(), end: jest.fn() };
    await service.generateScripts(owner, "p", res as any);
    expect(repo.saveScript.mock.calls[0][1].script).toBe(manuscript);
    expect(res.write).toHaveBeenCalledWith(`data: ${JSON.stringify(manuscript)}\n\n`);
  } else {
    expect((await service.regenerateScript(owner, "s")).script).toBe(manuscript);
    expect(repo.editScript).toHaveBeenCalledWith("s", { script: manuscript });
  }
  const [system, prompt] = (mode === "initial" ? ai : textAi).mock.calls[0];
  expect(system).toContain("faceless");
  expect(prompt).toContain(JSON.stringify({ concept: idea.concept, type: "short", evidence: idea.evidence }));
  expect(prompt).toContain("Quiet Brand");
  expect(prompt).toContain("PROFILE_SENTINEL");
});
it.each(["initial", "regenerate"])("%s refuses a foreign linked idea before provider invocation", async mode => {
  const { service, repo } = setup({ ...idea, accountId: OTHER_ACCOUNT_ID, concept: "FOREIGN_SECRET" });
  const call = mode === "initial" ? service.generateScripts(owner, "p", {} as any) : service.regenerateScript(owner, "s");
  await expect(call).rejects.toMatchObject({ statusCode: 403 });
  expect(ai).not.toHaveBeenCalled();
  expect(textAi).not.toHaveBeenCalled();
  expect(repo.editScript).not.toHaveBeenCalled();
  expect(repo.saveScript).not.toHaveBeenCalled();
});
it.each([false, true])("regeneration handles legacy missing idea context (link present=%s)", async linked => {
  const { service, repo } = setup(null, linked);
  await service.regenerateScript(owner, "s");
  expect(textAi.mock.calls[0][1]).toContain("Legacy title");
  expect(textAi.mock.calls[0][1]).toContain(JSON.stringify({ concept: "", type: "", evidence: "" }));
  expect(repo.getIdea).toHaveBeenCalledTimes(linked ? 1 : 0);
});

import HooksService from "../../src/service/hooks.service";
import PackagingService from "../../src/service/packaging.service";
it.each(["hooks", "title", "description", "thumbnail", "shorts"])("%s preserves the edited manuscript and active brand context downstream", async kind => {
  const edited = "EDITED_AUTHORITY {creatorContext} $&\n\n[Pause]\n\n[On screen: Supported comparison]";
  const ctx = { assemble: jest.fn().mockResolvedValue({
    channelContext: { brandName: "ACTIVE_BRAND", channelDescription: "Precise and calm", niche: "science", targetAudience: "students", format: "faceless", topTitles: [] },
    sessionContext: { script: "OBSOLETE_MANUSCRIPT", selectedHook: "Supported opening", workingTitle: "Comparison" },
  }) };
  const output = { hooks: ["a", "b", "c", "d", "e"], titles: [{ title: "Comparison", score: 7, reason: "Clear" }], description: "Useful comparison", descriptions: ["Objects", "Chart", "Diagram"], segments: [{ startTime: "0:00", endTime: "0:15", content: "A point", type: "point" }], totalDuration: "0:15" };
  ai.mockImplementation(async () => ({ stream: (async function* () { yield { text: () => JSON.stringify(output) }; })() }));
  if (kind === "hooks") {
    const repo = { save: jest.fn().mockResolvedValue({ id: "h", hooks: output.hooks }) };
    const vp = { getById: jest.fn().mockResolvedValue({}), linkResource: jest.fn() };
    await new HooksService(repo as any, vp as any, ctx as any, unmeteredSteps, fakeAccountRepo()).generate(owner, "p", edited);
    expect(ctx.assemble).toHaveBeenCalledWith(owner, { videoProjectId: "p" });
  } else {
    const service = new PackagingService({} as any, {} as any, ctx as any, fakeAccountRepo(), undefined, unmeteredSteps);
    if (kind === "title") await service.generateTitle(owner, edited);
    if (kind === "description") await service.generateDescription(owner, edited, "Title");
    if (kind === "thumbnail") await service.generateThumbnail(owner, edited, "Title");
    if (kind === "shorts") await service.generateShorts(owner, edited, 15);
  }
  expect(ctx.assemble).toHaveBeenCalledTimes(1);
  expect(ai.mock.calls[0][1]).toContain(edited);
  expect(ai.mock.calls[0][1]).toContain("ACTIVE_BRAND");
  expect(ai.mock.calls[0][1]).toContain("Precise and calm");
  expect(ai.mock.calls[0][1]).not.toContain("OBSOLETE_MANUSCRIPT");
});

it.each(["initial", "regenerate"])("%s rejects provider-truncated text before persistence", async mode => {
  const { service, repo } = setup();
  ai.mockResolvedValue({
    stream: (async function* () { yield { text: () => "Useful opening, but unfinished" }; })(),
    response: Promise.resolve({ candidates: [{ finishReason: "MAX_TOKENS" }] }),
  });
  textAi.mockResolvedValue({ response: { text: () => "Useful opening, but unfinished", candidates: [{ finishReason: "MAX_TOKENS" }] } });
  const res = { setHeader: jest.fn(), flushHeaders: jest.fn(), write: jest.fn(), end: jest.fn() };
  await expect(mode === "initial" ? service.generateScripts(owner, "p", res as any) : service.regenerateScript(owner, "s"))
    .rejects.toMatchObject({ statusCode: 503 });
  expect(repo.saveScript).not.toHaveBeenCalled();
  expect(repo.editScript).not.toHaveBeenCalled();
  expect(res.write).not.toHaveBeenCalledWith("data: [DONE]\n\n");
});

it.each(["SAFETY", "RECITATION", "OTHER", "FINISH_REASON_UNSPECIFIED"])("rejects explicit incomplete finish reason %s", async finishReason => {
  const { service, repo } = setup();
  textAi.mockResolvedValue({ response: { text: () => manuscript, candidates: [{ finishReason }] } });
  await expect(service.regenerateScript(owner, "s")).rejects.toMatchObject({ statusCode: 503 });
  expect(repo.editScript).not.toHaveBeenCalled();
});

it("does not save when the complete response fails", async () => {
  const { service, repo } = setup();
  textAi.mockRejectedValue(Object.assign(new Error("Provider response interrupted"), { statusCode: 503 }));
  await expect(service.regenerateScript(owner, "s")).rejects.toMatchObject({ statusCode: 503 });
  expect(repo.editScript).not.toHaveBeenCalled();
});

it("saves a complete long draft verbatim without trimming its body or production cues", async () => {
  const { service, repo } = setup();
  const draft = `${"Explain the mechanism and apply the tradeoff. ".repeat(200)}\n\n[Pause]\n\nA practical ending.`;
  textAi.mockResolvedValue({ response: { text: () => draft, candidates: [{ finishReason: "STOP" }] } });
  expect((await service.regenerateScript(owner, "s")).script).toBe(draft);
  expect(repo.editScript).toHaveBeenCalledWith("s", { script: draft });
});
