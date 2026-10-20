import StepRunner from "../../src/service/step-runner";
import type BillingRepository from "../../src/repository/billing.repository";
import ExtractService from "../../src/service/extract.service";
import ExtractRepository from "../../src/repository/extract.repository";
import { unmeteredSteps } from "../helpers/step-runner";
jest.mock("firebase-admin", () => ({
  apps: [],
  initializeApp: jest.fn(),
  credential: { cert: jest.fn() },
  firestore: Object.assign(jest.fn().mockReturnValue({}), {
    FieldValue: { serverTimestamp: jest.fn() },
  }),
  auth: jest.fn().mockReturnValue({ verifyIdToken: jest.fn() }),
}));

jest.mock("../../src/config/firebase", () => ({
  db: {},
  auth: {},
  firebase: { firestore: { FieldValue: { serverTimestamp: jest.fn() } } },
}));

jest.mock("../../src/config/ai", () => ({
  __esModule: true,
  default: jest.fn(),
  embeddingModel: { embedContent: jest.fn() },
}));

jest.mock("../../src/utlils/ai", () => ({
  // collectJson stays REAL: it is the empty/malformed-JSON guard, and the fake
  // streams below are exactly what should be driving it.
  collectJson: jest.requireActual("../../src/utlils/ai").collectJson,
  generateStreamingContent: jest.fn(),
  generateContent: jest.fn(),
}));

jest.mock("../../src/utlils/content", () => ({
  resolveChannel: jest.fn(),
  formatUserData: jest.fn(),
}));

jest.mock("../../src/repository/user.repository");
jest.mock("../../src/repository/extract.repository");

import { fakeAccountRepo, testOwner } from "../helpers/account";
import UserService from "../../src/service/user.service";
import UserRepository from "../../src/repository/user.repository";
import { resolveChannel } from "../../src/utlils/content";
import { generateStreamingContent } from "../../src/utlils/ai";

const makeStream = (text: string) => ({
  stream: (async function* () {
    yield { text: () => text };
  })(),
});

const mockResolve = resolveChannel as jest.Mock;
const mockGenerate = generateStreamingContent as jest.Mock;

describe("UserService.prefillFromChannel", () => {
  let service: UserService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new UserService(new UserRepository() as never, fakeAccountRepo(), unmeteredSteps, new ExtractService(new ExtractRepository()));
    mockGenerate.mockImplementation(async () =>
      makeStream(
        JSON.stringify({
          niche: "Personal finance",
          targetAudience: "millennials",
          brandName: "MoneyGuy",
        })
      )
    );
  });

  it("infers suggestions and echoes the resolved channel signal", async () => {
    mockResolve.mockResolvedValue({
      id: "chan-1",
      description: "A channel about personal finance",
      titles: ["How to save", "Invest in 2026"],
    });

    const result = await service.prefillFromChannel("https://youtube.com/@x", { userId: "user-1", accountId: "account-1" });

    expect(result.suggestions).toEqual({
      niche: "Personal finance",
      targetAudience: "millennials",
      brandName: "MoneyGuy",
    });
    expect(result.channel).toEqual({
      channelDescription: "A channel about personal finance",
      topTitles: ["How to save", "Invest in 2026"],
    });
    expect(mockGenerate).toHaveBeenCalledTimes(1);

    // The channel signal is actually interpolated into the prompt (both
    // placeholders filled — guards against a wrong-placeholder regression).
    const userPrompt = mockGenerate.mock.calls[0][1] as string;
    expect(userPrompt).toContain("A channel about personal finance");
    expect(userPrompt).toContain("How to save");
    expect(userPrompt).toContain("Invest in 2026");
    expect(userPrompt).not.toMatch(/\{channelDescription\}|\{topTitles\}/);
  });

  it("returns blank suggestions without calling the model when there is no signal", async () => {
    mockResolve.mockResolvedValue({ id: "", description: "", titles: [] });

    const result = await service.prefillFromChannel("https://youtube.com/@x", { userId: "user-1", accountId: "account-1" });

    expect(result.suggestions).toEqual({
      niche: "",
      targetAudience: "",
      brandName: "",
    });
    expect(mockGenerate).not.toHaveBeenCalled();
  });

  it("infers from titles alone when the description is empty", async () => {
    mockResolve.mockResolvedValue({ id: "c", description: "", titles: ["A title"] });

    await service.prefillFromChannel("https://youtube.com/@x", { userId: "user-1", accountId: "account-1" });
    expect(mockGenerate).toHaveBeenCalledTimes(1);
  });

  it("defaults any missing field in the model output to an empty string", async () => {
    mockResolve.mockResolvedValue({ id: "c", description: "d", titles: [] });
    mockGenerate.mockImplementation(async () =>
      makeStream(JSON.stringify({ niche: "AI tools" }))
    );

    const result = await service.prefillFromChannel("https://youtube.com/@x", { userId: "user-1", accountId: "account-1" });
    expect(result.suggestions).toEqual({
      niche: "AI tools",
      targetAudience: "",
      brandName: "",
    });
  });
});

// resolveChannel used to swallow every failure into `{id:"",description:"",titles:[]}`,
// which callers couldn't tell apart from a channel that genuinely has no
// description — so a quota-exhausted refresh wrote those empties over good
// stored enrichment. It now returns null on failure.
describe("UserService.prefillFromChannel — unresolvable channel", () => {
  let service: UserService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new UserService(new UserRepository() as never, fakeAccountRepo(), unmeteredSteps, new ExtractService(new ExtractRepository()));
  });

  it("returns blank suggestions without calling the model when resolution fails", async () => {
    mockResolve.mockResolvedValue(null);

    const result = await service.prefillFromChannel("https://youtube.com/@x", { userId: "user-1", accountId: "account-1" });

    expect(result.suggestions).toEqual({
      niche: "",
      targetAudience: "",
      brandName: "",
    });
    expect(result.channel).toEqual({ channelDescription: "", topTitles: [] });
  });
});

/**
 * The lock must cover the EXPENSIVE part, not just the model call.
 *
 * `steps.run` used to be opened inside `inferOnboardingFields`, which is only reached
 * when the channel yielded a signal. So the YouTube resolution and website scrape — the
 * quota-metered work — ran entirely outside it, and a channel that resolved to nothing
 * never took a lock or had its membership checked at all.
 */
describe("prefill reserves BEFORE it spends YouTube quota", () => {
  const recordingService = () => {
    const order: string[] = [];
    const steps = new StepRunner({
      reserve: async () => {
        order.push("reserve");
        return null; // prefill is free; a null charge is the real cost-0 shape
      },
      settle: async () => {
        order.push("settle");
        return true;
      },
    } as unknown as Pick<BillingRepository, "reserve" | "settle">);
    mockResolve.mockImplementation(async () => {
      order.push("resolve-channel");
      return { id: "UC1", description: "A finance channel", titles: ["One"] };
    });
    const service = new UserService(
      new UserRepository() as never,
      fakeAccountRepo(),
      steps,
      new ExtractService(new ExtractRepository())
    );
    return { service, order };
  };

  it("takes the reservation before resolving the channel", async () => {
    const { service, order } = recordingService();

    await service.prefillFromChannel("https://youtube.com/@money", testOwner("user-1"));

    expect(order[0]).toBe("reserve");
    expect(order).toContain("resolve-channel");
    expect(order.indexOf("reserve")).toBeLessThan(order.indexOf("resolve-channel"));
  });

  it("still reserves when the channel yields NO signal", async () => {
    // The gap that made this worse than a quota question: with no signal the old code
    // skipped `steps.run` entirely, so this path had no lock and no membership check.
    const { service, order } = recordingService();
    mockResolve.mockImplementation(async () => {
      order.push("resolve-channel");
      return { id: "", description: "", titles: [] };
    });

    const out = await service.prefillFromChannel("https://youtube.com/@empty", testOwner("user-1"));

    expect(out.suggestions).toEqual({ niche: "", targetAudience: "", brandName: "" });
    expect(order).toEqual(["reserve", "resolve-channel", "settle"]);
  });
});
