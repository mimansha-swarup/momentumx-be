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
  generateStreamingContent: jest.fn(),
  generateContent: jest.fn(),
}));

jest.mock("../../src/utlils/content", () => ({
  resolveChannel: jest.fn(),
  formatUserData: jest.fn(),
}));

jest.mock("../../src/repository/user.repository");
jest.mock("../../src/repository/extract.repository");

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
    service = new UserService(new UserRepository() as never);
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

    const result = await service.prefillFromChannel("https://youtube.com/@x");

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

    const result = await service.prefillFromChannel("https://youtube.com/@x");

    expect(result.suggestions).toEqual({
      niche: "",
      targetAudience: "",
      brandName: "",
    });
    expect(mockGenerate).not.toHaveBeenCalled();
  });

  it("infers from titles alone when the description is empty", async () => {
    mockResolve.mockResolvedValue({ id: "c", description: "", titles: ["A title"] });

    await service.prefillFromChannel("https://youtube.com/@x");
    expect(mockGenerate).toHaveBeenCalledTimes(1);
  });

  it("defaults any missing field in the model output to an empty string", async () => {
    mockResolve.mockResolvedValue({ id: "c", description: "d", titles: [] });
    mockGenerate.mockImplementation(async () =>
      makeStream(JSON.stringify({ niche: "AI tools" }))
    );

    const result = await service.prefillFromChannel("https://youtube.com/@x");
    expect(result.suggestions).toEqual({
      niche: "AI tools",
      targetAudience: "",
      brandName: "",
    });
  });
});
