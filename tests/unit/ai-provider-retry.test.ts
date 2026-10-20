import { GenerateContentStreamResult, GoogleGenerativeAIError, GoogleGenerativeAIFetchError } from "@google/generative-ai";
import type { CreditReservation } from "../../src/repository/billing.repository";
import StepRunner from "../../src/service/step-runner";
import { errorHandler } from "../../src/middleware/error_handler";
import type { Request, Response } from "express";

const mockRequest = jest.fn();
jest.mock("../../src/config/ai", () => ({
  __esModule: true,
  default: () => ({
    generateContentStream: (...args: unknown[]) => mockRequest(...args),
    generateContent: (...args: unknown[]) => mockRequest(...args),
  }),
}));

import { collectJson, generateContent, generateStreamingContent, generateTextContent } from "../../src/utlils/ai";

const busy = () => new GoogleGenerativeAIFetchError("private provider details", 503, "Unavailable");
const generate = () => generateStreamingContent("system", "user", {});
const stream = () => ({
  stream: (async function* () { yield { text: () => '{"idea":"example"}' }; })(),
}) as GenerateContentStreamResult;

describe("provider busy recovery", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(Math, "random").mockReturnValue(0);
    jest.spyOn(console, "warn").mockImplementation(() => undefined);
    jest.spyOn(console, "error").mockImplementation(() => undefined);
    mockRequest.mockReset();
  });
  afterEach(() => { jest.useRealTimers(); jest.restoreAllMocks(); });

  it.each([true, false])("retries within one reservation, then saves and settles once with metering %s", async debited => {
    mockRequest.mockRejectedValueOnce(busy()).mockRejectedValueOnce(busy()).mockResolvedValueOnce(stream());
    const charge = { debited } as CreditReservation;
    const billing = { reserve: jest.fn().mockResolvedValue(charge), settle: jest.fn().mockResolvedValue(true) };
    const save = jest.fn(async (value: unknown) => value);
    const pending = new StepRunner(billing).run(
      { actor: { userId: "user", accountId: "account" }, kind: "ideas" },
      async () => save(await collectJson(await generate(), "ideas")),
    );
    await jest.runAllTimersAsync();
    await expect(pending).resolves.toEqual({ idea: "example" });
    expect(mockRequest.mock.calls.map(call => call[1].timeout)).toEqual([120_000, 119_500, 118_500]);
    expect(billing.reserve).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledTimes(1);
    expect(billing.settle).toHaveBeenCalledTimes(1);
    expect(billing.settle).toHaveBeenCalledWith(charge, false);
  });

  it.each([true, false])("releases failed reservation and returns useful 503 with metering %s", async debited => {
    mockRequest.mockRejectedValue(busy());
    const charge = { debited } as CreditReservation;
    const billing = { reserve: jest.fn().mockResolvedValue(charge), settle: jest.fn().mockResolvedValue(true) };
    const pending = new StepRunner(billing).run(
      { actor: { userId: "user", accountId: "account" }, kind: "ideas" }, generate,
    ).catch(error => error);
    await jest.runAllTimersAsync();
    const error = await pending;
    expect(error).toMatchObject({ statusCode: 503, message: "Generation service is temporarily busy. Please try again shortly." });
    const sendError = jest.fn();
    errorHandler(error, { originalUrl: "/v1/ideas/generate" } as Request, { headersSent: false, sendError } as unknown as Response, jest.fn());
    expect(sendError).toHaveBeenCalledWith({
      statusCode: 503,
      message: "Generation service is temporarily busy. Please try again shortly.",
      ...(debited ? { detail: { charged: false } } : {}),
    });
    expect(mockRequest).toHaveBeenCalledTimes(3);
    expect(billing.settle).toHaveBeenCalledTimes(1);
    expect(billing.settle).toHaveBeenCalledWith(charge, true);
  });

  it.each([400, 401, 403, 404, 500])("does not retry upstream %s", async status => {
    const error = new GoogleGenerativeAIFetchError("upstream", status);
    mockRequest.mockRejectedValue(error);
    await expect(generate()).rejects.toBe(error);
    expect(mockRequest).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  it("does not replay a stream that fails after opening", async () => {
    mockRequest.mockResolvedValue({ stream: (async function* () { yield { text: () => "{" }; throw busy(); })() });
    await expect(collectJson(await generate(), "ideas")).rejects.toMatchObject({ statusCode: 503 });
    expect(mockRequest).toHaveBeenCalledTimes(1);
  });

  it.each(["stream", "json"])("curates daily quota rejection in %s without retrying or saving", async transport => {
    mockRequest.mockRejectedValue(new GoogleGenerativeAIFetchError("private provider data", 429, "", [
      { "@type": "type.googleapis.com/google.rpc.QuotaFailure", violations: [{ quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier" }] },
      { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "20078.1s" },
    ]));
    const charge = { debited: true } as CreditReservation;
    const billing = { reserve: jest.fn().mockResolvedValue(charge), settle: jest.fn().mockResolvedValue(true) };
    const save = jest.fn();
    const error = await new StepRunner(billing).run(
      { actor: { userId: "user", accountId: "account" }, kind: "script" },
      async () => { const result = await (transport === "json" ? generateTextContent("system", "user", {}) : generate()); return save(result); },
    ).catch(error => error);
    expect(error).toMatchObject({ statusCode: 429, code: "provider_quota_exceeded", detail: { retryAfterSeconds: 20079, charged: false } });
    expect(error.message).toContain("daily quota");
    expect(error.message).not.toContain("private provider data");
    const sendError = jest.fn();
    errorHandler(error, { originalUrl: "/v1/scripts/project/regenerate" } as Request,
      { headersSent: false, sendError } as unknown as Response, jest.fn());
    expect(sendError).toHaveBeenCalledWith({ message: error.message, statusCode: 429, code: "provider_quota_exceeded", detail: { retryAfterSeconds: 20079, charged: false } });
    expect(mockRequest).toHaveBeenCalledTimes(1);
    expect(save).not.toHaveBeenCalled();
    expect(billing.settle).toHaveBeenCalledWith(charge, true);
    expect(jest.getTimerCount()).toBe(0);
  });

  it.each([undefined, "-1s", "Infinitys", "1e4s", "9999999999999999999s", "30seconds"])("does not invent a daily quota or retry delay from %s", async retryDelay => {
    mockRequest.mockRejectedValue(new GoogleGenerativeAIFetchError("daily quota reached private", 429, "", [
      { "@type": "type.googleapis.com/google.rpc.QuotaFailure", violations: [null, {}, { quotaId: "GenerateRequestsPerMinutePerProject" }] },
      { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay },
    ]));
    await expect(generate()).rejects.toMatchObject({ statusCode: 429, code: "provider_rate_limited", detail: undefined,
      message: "The generation provider is limiting requests. Please try again later." });
    expect(mockRequest).toHaveBeenCalledTimes(1);
  });

  it.each(["Failed to parse stream", 'Error parsing JSON response: "private output"'])("makes SDK parser failure legible without replaying: %s", async message => {
    const error = new GoogleGenerativeAIError(message);
    mockRequest.mockResolvedValue({
      stream: (async function* () { yield { text: () => "Partial draft" }; throw error; })(),
      response: Promise.reject(error),
    });
    const result = await generate();
    const read = async () => { for await (const _chunk of result.stream) { /* Drain the provider stream. */ } };
    await expect(read()).rejects.toMatchObject({ statusCode: 503, message: "Generation was interrupted before a complete response arrived. Please try again." });
    await expect(result.response).rejects.toBe(error);
    expect(mockRequest).toHaveBeenCalledTimes(1);
    expect(console.error).toHaveBeenCalledWith(JSON.stringify({ event: "ai_stream_parse_failed" }));
  });

  it("does not relabel unrelated errors or matching application error strings", async () => {
    const error = new Error("[GoogleGenerativeAI Error]: Failed to parse stream");
    mockRequest.mockResolvedValue({ stream: (async function* () { throw error; })() });
    const result = await generate();
    await expect(result.stream.next()).rejects.toBe(error);
    expect(mockRequest).toHaveBeenCalledTimes(1);
  });

  it("does not start another request after the shared timeout budget is spent", async () => {
    mockRequest.mockImplementation(async () => { jest.setSystemTime(Date.now() + 119_800); throw busy(); });
    await expect(generate()).rejects.toMatchObject({ statusCode: 503 });
    expect(mockRequest).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  it("also retries inline-context requests without changing the submitted content", async () => {
    mockRequest.mockRejectedValueOnce(busy()).mockResolvedValueOnce(stream());
    const pending = generateContent("system", "user", {}, "text/plain", "context");
    await jest.runAllTimersAsync();
    await pending;
    expect(mockRequest).toHaveBeenCalledTimes(2);
    expect(mockRequest.mock.calls[0][0]).toEqual(mockRequest.mock.calls[1][0]);
  });
});
