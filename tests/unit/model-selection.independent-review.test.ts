// Exercise the installed SDK and shared wrappers; fetch never leaves this process.
export {};
const previousModel = process.env.GENERATION_MODEL;
const previousKey = process.env.API_KEY;
const originalFetch = global.fetch;
const selectedModel = "gemini-fixture-custom";
const candidate = { candidates: [{ index: 0, content: { role: "model", parts: [{ text: '{"ok":true}' }] }, finishReason: "STOP" }] };

beforeEach(() => {
  jest.useFakeTimers();
  jest.resetModules();
  process.env.GENERATION_MODEL = selectedModel;
  process.env.API_KEY = "fixture-key-never-live";
});
afterEach(() => {
  if (previousModel === undefined) delete process.env.GENERATION_MODEL;
  else process.env.GENERATION_MODEL = previousModel;
  if (previousKey === undefined) delete process.env.API_KEY;
  else process.env.API_KEY = previousKey;
  global.fetch = originalFetch;
  jest.restoreAllMocks();
  jest.clearAllTimers();
  jest.useRealTimers();
});

it("routes plain streams, structured inline streams and complete JSON through the selected SDK endpoint", async () => {
  global.fetch = jest.fn().mockImplementation(async (url: string) => new Response(
    url.includes("streamGenerateContent") ? `data: ${JSON.stringify(candidate)}\n\n` : JSON.stringify(candidate),
    { status: 200, headers: { "Content-Type": url.includes("streamGenerateContent") ? "text/event-stream" : "application/json" } },
  ));
  const ai = await import("../../src/utlils/ai");
  await expect(ai.collectJson(await ai.generateStreamingContent("system", "prompt", {}), "fixture")).resolves.toEqual({ ok: true });
  await expect(ai.collectJson(await ai.generateContent("system", "prompt", { responseMimeType: "application/json" }, "text/plain", "context"), "fixture")).resolves.toEqual({ ok: true });
  expect((await ai.generateTextContent("system", "prompt", {})).response.text()).toBe('{"ok":true}');
  const calls = (global.fetch as jest.Mock).mock.calls;
  expect(calls.map(([url]) => url)).toEqual([
    `https://generativelanguage.googleapis.com/v1beta/models/${selectedModel}:streamGenerateContent?alt=sse`,
    `https://generativelanguage.googleapis.com/v1beta/models/${selectedModel}:streamGenerateContent?alt=sse`,
    `https://generativelanguage.googleapis.com/v1beta/models/${selectedModel}:generateContent`,
  ]);
  const structuredBody = JSON.parse(calls[1][1].body);
  expect(structuredBody.generationConfig.responseMimeType).toBe("application/json");
  expect(structuredBody.contents[0].parts[1].inlineData).toEqual({ mimeType: "text/plain", data: Buffer.from("context").toString("base64") });
});

it("keeps the selected model on every busy retry and logs no provider body or credential", async () => {
  jest.useFakeTimers();
  const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
  global.fetch = jest.fn().mockImplementation(async () => new Response(JSON.stringify({ error: { message: "private-provider-body" } }), { status: 503 }));
  const { generateTextContent } = await import("../../src/utlils/ai");
  const rejected = expect(generateTextContent("system", "private-prompt", {})).rejects.toMatchObject({ statusCode: 503 });
  await jest.runAllTimersAsync();
  await rejected;
  expect(global.fetch).toHaveBeenCalledTimes(3);
  expect(new Set((global.fetch as jest.Mock).mock.calls.map(([url]) => url))).toEqual(new Set([
    `https://generativelanguage.googleapis.com/v1beta/models/${selectedModel}:generateContent`,
  ]));
  expect(warn.mock.calls.map(([entry]) => JSON.parse(entry))).toEqual([1, 2, 3].map(attempt => ({ event: "ai_provider_busy", attempt, status: 503, model: selectedModel, transport: "json" })));
});
