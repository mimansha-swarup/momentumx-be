export {};

const previousModel = process.env.GENERATION_MODEL;
const originalFetch = global.fetch;

afterEach(() => {
  if (previousModel === undefined) delete process.env.GENERATION_MODEL;
  else process.env.GENERATION_MODEL = previousModel;
  global.fetch = originalFetch;
  jest.resetModules();
});

function loadModel(value?: string) {
  if (value === undefined) delete process.env.GENERATION_MODEL;
  else process.env.GENERATION_MODEL = value;
  jest.resetModules();
  return require("../../src/config/ai") as typeof import("../../src/config/ai");
}

it("uses the agreed Flash 3.8 default without changing the embedding model", () => {
  const config = loadModel();
  expect(config.GENERATION_MODEL).toBe("gemini-3.8-flash");
  expect(config.default("System", {}).model).toBe("models/gemini-3.8-flash");
  expect(config.embeddingModel.model).toBe("models/gemini-embedding-001");
});

it("trims the explicit model and sends it through the actual SDK without changing embeddings", async () => {
  const config = loadModel("  gemini-test-model-001  ");
  global.fetch = jest.fn().mockResolvedValue(new Response(JSON.stringify({ candidates: [
    { content: { role: "model", parts: [{ text: "Complete draft" }] }, finishReason: "STOP" },
  ] }), { status: 200, headers: { "Content-Type": "application/json" } }));
  const { generateTextContent } = require("../../src/utlils/ai") as typeof import("../../src/utlils/ai");
  const result = await generateTextContent("System", "Draft", {});
  expect(result.response.text()).toBe("Complete draft");
  expect((global.fetch as jest.Mock).mock.calls[0][0]).toBe(
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-test-model-001:generateContent",
  );
  expect(config.embeddingModel.model).toBe("models/gemini-embedding-001");
});

it.each(["", "  ", "models/gemini-flash", "https://example.test/model", "../model", "model?key=secret", "model\nother"])(
  "rejects invalid configuration without reflecting its contents", value => {
    expect(() => loadModel(value)).toThrow(
      "GENERATION_MODEL must be a nonempty model ID, without a URL or models/ prefix",
    );
  },
);
