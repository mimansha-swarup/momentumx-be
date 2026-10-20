// Real SDK error parsing, with fetch replaced before any generation request.
export {};
const originalFetch = global.fetch;
const previousModel = process.env.GENERATION_MODEL;
const previousKey = process.env.API_KEY;

beforeEach(() => {
  jest.resetModules();
  process.env.GENERATION_MODEL = "gemini-3.8-flash";
  process.env.API_KEY = "private-fixture-key";
  jest.spyOn(console, "warn").mockImplementation(() => undefined);
  jest.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  global.fetch = originalFetch;
  if (previousModel === undefined) delete process.env.GENERATION_MODEL;
  else process.env.GENERATION_MODEL = previousModel;
  if (previousKey === undefined) delete process.env.API_KEY;
  else process.env.API_KEY = previousKey;
  jest.restoreAllMocks();
});

it.each([
  ["GenerateRequestsPerDayPerProjectPerModel-FreeTier", /daily/i],
  ["GenerateRequestsPerMinutePerProjectPerModel-FreeTier", /limiting requests/i],
])("handles SDK quota violation %s once and releases the reservation", async (quotaId, expectedMessage) => {
  global.fetch = jest.fn().mockImplementation(async () => new Response(JSON.stringify({ error: {
    code: 429,
    message: "private-provider-body: models/gemini-3.6-flash and private-fixture-key",
    status: "RESOURCE_EXHAUSTED",
    details: [
      { "@type": "type.googleapis.com/google.rpc.QuotaFailure", violations: [{
        quotaMetric: "generativelanguage.googleapis.com/generate_content_free_tier_requests",
        quotaId,
        quotaDimensions: { model: "gemini-3.6-flash", location: "global" }, quotaValue: "20",
      }] },
      { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "20078s" },
    ],
  } }), { status: 429, headers: { "Content-Type": "application/json" } }));
  const { generateTextContent } = await import("../../src/utlils/ai");
  const { default: StepRunner } = await import("../../src/service/step-runner");
  const { errorHandler } = await import("../../src/middleware/error_handler");
  const charge = { debited: true } as import("../../src/repository/billing.repository").CreditReservation;
  const billing = { reserve: jest.fn().mockResolvedValue(charge), settle: jest.fn().mockResolvedValue(true) };
  const save = jest.fn();
  const error = await new StepRunner(billing).run(
    { actor: { userId: "fixture-user", accountId: "fixture-account" }, kind: "script" },
    async () => { const result = await generateTextContent("private-system", "private-prompt", {}); save(result); },
  ).catch(error => error);
  expect(error).toMatchObject({ statusCode: 429, message: expect.stringMatching(expectedMessage), detail: { charged: false } });
  expect(global.fetch).toHaveBeenCalledTimes(1);
  expect((global.fetch as jest.Mock).mock.calls[0][0]).toContain("models/gemini-3.8-flash:generateContent");
  expect(save).not.toHaveBeenCalled();
  expect(billing.reserve).toHaveBeenCalledTimes(1);
  expect(billing.settle).toHaveBeenCalledTimes(1);
  expect(billing.settle).toHaveBeenCalledWith(charge, true);
  const sendError = jest.fn();
  errorHandler(error, { originalUrl: "/v1/scripts/regenerate" } as import("express").Request,
    { headersSent: false, sendError } as unknown as import("express").Response, jest.fn());
  expect(sendError).toHaveBeenCalledWith({ statusCode: 429, message: expect.stringMatching(expectedMessage), code: quotaId.includes("PerDay") ? "provider_quota_exceeded" : "provider_rate_limited", detail: { charged: false, retryAfterSeconds: 20078 } });
  const disclosed = JSON.stringify([sendError.mock.calls, (console.warn as jest.Mock).mock.calls, (console.error as jest.Mock).mock.calls]);
  for (const secret of ["private-provider-body", "private-fixture-key", "private-system", "private-prompt"]) expect(disclosed).not.toContain(secret);
});
