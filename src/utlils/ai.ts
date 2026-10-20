import type { GenerationProgress } from "./generation-progress.js";
import { ApiError, GoogleGenAI } from "@google/genai";
import { GenerationConfig, GenerateContentStreamResult, GoogleGenerativeAIError, GoogleGenerativeAIFetchError, GoogleGenerativeAIAbortError } from "@google/generative-ai";
import genAIModel, { GENERATION_MODEL } from "../config/ai.js";
import { HttpError, ServiceUnavailable } from "./errors.js";
export const generateContent = async (
  systemPrompt: string,
  userPrompt: string,
  generationConfig: GenerationConfig,
  mimeType: string,
  inlineData: string,
  onRetry?: () => void
) => {
  const blob = new Blob([inlineData], { type: mimeType });
  const arrayBuffer = await blob.arrayBuffer();
  const base64Text = btoa(String.fromCharCode(...new Uint8Array(arrayBuffer)));

  const model = genAIModel(
    systemPrompt,
    generationConfig
  );
  return startStream(timeout => model.generateContentStream(
    {
      contents: [
        {
          role: "user",
          parts: [
            { text: userPrompt },
            {
              inlineData: {
                mimeType,
                data: base64Text,
              },
            },
          ],
        },
      ],
    },
    { timeout }
  ), onRetry);
};
// Bounds the whole Gemini request (connect + stream). Without it a stalled
// upstream connection hangs the SSE client forever with no error to react to.
const STREAM_TIMEOUT_MS = 120_000;

// A provider quota is separate from application credits. Only structured daily
// quota violations justify telling the creator that the daily limit was reached.
const providerLimitError = (error: GoogleGenerativeAIFetchError): HttpError => {
  const details = Array.isArray(error.errorDetails) ? error.errorDetails : [];
  const daily = details.some(detail => detail?.["@type"] === "type.googleapis.com/google.rpc.QuotaFailure" &&
    Array.isArray(detail.violations) && detail.violations.some((violation: unknown) =>
      violation !== null && typeof violation === "object" && "quotaId" in violation &&
      typeof violation.quotaId === "string" && /PerDay(?:Per|$)/.test(violation.quotaId)));
  const retry = details.find(detail => detail?.["@type"] === "type.googleapis.com/google.rpc.RetryInfo")?.retryDelay;
  const seconds = typeof retry === "string" && /^\d+(?:\.\d{1,9})?s$/.test(retry)
    ? Math.ceil(Number(retry.slice(0, -1))) : undefined;
  const retryAfterSeconds = seconds !== undefined && Number.isSafeInteger(seconds) && seconds >= 0 ? seconds : undefined;
  let message = daily
    ? "The generation provider's daily quota has been reached. Try later, or ask the service administrator to check the provider quota and billing."
    : "The generation provider is limiting requests. Please try again later.";
  if (retryAfterSeconds !== undefined) {
    // This is the provider's retry advice, not a promise that quota will reset.
    const minutes = Math.max(1, Math.ceil(retryAfterSeconds / 60));
    message += ` The provider suggests waiting at least ${minutes} minute${minutes === 1 ? "" : "s"} before retrying.`;
  }
  console.warn(JSON.stringify({ event: "ai_provider_limited", status: 429, model: GENERATION_MODEL, daily, retryAfterSeconds }));
  return new HttpError(message, 429,
    retryAfterSeconds === undefined ? undefined : { retryAfterSeconds },
    daily ? "provider_quota_exceeded" : "provider_rate_limited");
};

// Retry only an explicit HTTP 503 rejection. A failed response body or opened
// stream is never replayed; persistence and credit settlement stay outside.
const requestWithBusyRetry = async <T>(
  request: (timeout: number) => Promise<T>,
  transport: "stream" | "json",
  onRetry?: () => void,
  deadline = Date.now() + STREAM_TIMEOUT_MS
): Promise<T> => {
  for (let attempt = 0; attempt < 3; attempt++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    try {
      return await request(remaining);
    } catch (error) {
      if (error instanceof ApiError && error.status === 429) {
        // The maintained SDK preserves provider quota details in its JSON message.
        let errorDetails;
        try { errorDetails = JSON.parse(error.message)?.error?.details; } catch { /* No structured details. */ }
        throw providerLimitError({ errorDetails } as GoogleGenerativeAIFetchError);
      }
      if (error instanceof GoogleGenerativeAIFetchError && error.status === 429) throw providerLimitError(error);
      if (!(error instanceof GoogleGenerativeAIFetchError || error instanceof ApiError) || error.status !== 503) throw error;
      console.warn(JSON.stringify({ event: "ai_provider_busy", attempt: attempt + 1, status: 503, model: GENERATION_MODEL, transport }));
      const delay = 500 * 2 ** attempt + Math.floor(Math.random() * 100);
      if (attempt === 2 || deadline - Date.now() <= delay) break;
      onRetry?.();
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  throw ServiceUnavailable("Generation service is temporarily busy. Please try again shortly.");
};

const startStream = async (
  request: (timeout: number) => Promise<GenerateContentStreamResult>,
  onRetry?: () => void
): Promise<GenerateContentStreamResult> => {
  const result = await requestWithBusyRetry(request, "stream", onRetry);
  // Observe the SDK's aggregate copy even if callers only consume the stream.
  void result.response?.catch(() => undefined);
  return { ...result, stream: readableStream(result.stream) };
};

async function* readableStream(stream: GenerateContentStreamResult["stream"]) {
  try {
    yield* stream;
  } catch (error) {
    // These SDK parser failures include a truncated final SSE event. Never
    // repair or replay a partial response, or expose its raw content in logs.
    if (error instanceof GoogleGenerativeAIError && (
      error.message === "[GoogleGenerativeAI Error]: Failed to parse stream" ||
      error.message.startsWith("[GoogleGenerativeAI Error]: Error parsing JSON response:")
    )) {
      console.error(JSON.stringify({ event: "ai_stream_parse_failed" }));
      throw ServiceUnavailable("Generation was interrupted before a complete response arrived. Please try again.");
    }
    throw error;
  }
}

export const generateStreamingContent = (
  systemPrompt: string,
  userPrompt: string,
  generationConfig: GenerationConfig
) => {
  const model = genAIModel(
    systemPrompt,
    generationConfig
  );
  return startStream(timeout => model.generateContentStream(userPrompt, { timeout }));
};

// JSON endpoints do not need a provider stream. Request the complete response
// so an SSE framing failure cannot discard an otherwise complete draft.
// Only explicit HTTP 503 rejections may retry, within the same operation.
export const generateTextContent = async (
  systemPrompt: string,
  userPrompt: string,
  generationConfig: GenerationConfig
) => {
  const controller = new AbortController();
  const deadline = Date.now() + STREAM_TIMEOUT_MS;
  const timeout = setTimeout(() => controller.abort(), STREAM_TIMEOUT_MS);
  try {
    const model = genAIModel(systemPrompt, generationConfig);
    return await requestWithBusyRetry(async () => {
      // The SDK does not reject an already-aborted external signal itself.
      controller.signal.throwIfAborted();
      return model.generateContent(userPrompt, { signal: controller.signal });
    }, "json", undefined, deadline);
  } catch (error) {
    // No replay: a body or transport failure may happen after generation began.
    if (controller.signal.aborted || error instanceof GoogleGenerativeAIAbortError ||
      // Response.json() can throw native errors from another JavaScript realm.
      (error != null && typeof error === "object" && "name" in error &&
        ["AbortError", "SyntaxError", "TypeError"].includes(String(error.name)))) {
      console.error(JSON.stringify({ event: "ai_response_interrupted" }));
      throw ServiceUnavailable("Generation was interrupted before a complete response arrived. Please try again.");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
};

/**
 * Drain a JSON generation stream and parse it, or fail with something the
 * creator can act on.
 *
 * Every JSON call site used to inline the same accumulate-then-`JSON.parse`, with
 * no guard on any of the three ways it can go wrong. All three surfaced as an
 * unhandled 500 — "Something went wrong" — which tells the user nothing and
 * tells us nothing either:
 *
 *   1. The stream throws mid-flight. `chunk.text()` raises when a safety filter
 *      blocks the response or the upstream connection dies.
 *   2. The stream completes empty. `JSON.parse("")` → "Unexpected end of JSON input".
 *   3. The body is malformed. Schemas make this rare, but hitting the output-token
 *      ceiling still truncates mid-object.
 *
 * Deliberately NOT doing any repair, cleaning, or retry — project rules are
 * explicit that malformed output means the prompt or config is wrong and must be
 * fixed there. This only makes the failure legible: a 503 the client can show and
 * retry, plus a structured log carrying enough to diagnose which of the three it
 * was. `label` names the thing being generated, for the user-facing message.
 */
export const collectJson = async <T>(
  result: GenerateContentStreamResult,
  label: string
): Promise<T> => {
  let accumulated = "";
  try {
    for await (const chunk of result.stream) {
      const part = chunk.text();
      if (part) accumulated += part;
    }
  } catch (streamError) {
    console.error(
      JSON.stringify({
        event: "ai_stream_failed",
        label,
        message: (streamError as Error)?.message,
      })
    );
    throw ServiceUnavailable(
      `Couldn't generate ${label} — the request was interrupted. Please try again.`
    );
  }

  if (!accumulated.trim()) {
    console.error(JSON.stringify({ event: "ai_empty_response", label }));
    throw ServiceUnavailable(
      `Couldn't generate ${label} — nothing came back. Please try again.`
    );
  }

  try {
    return JSON.parse(accumulated) as T;
  } catch (parseError) {
    console.error(
      JSON.stringify({
        event: "ai_malformed_json",
        label,
        length: accumulated.length,
        // Both ends: the head shows the shape, the tail shows truncation.
        head: accumulated.slice(0, 200),
        tail: accumulated.slice(-200),
        message: (parseError as Error)?.message,
      })
    );
    throw ServiceUnavailable(
      `Couldn't generate ${label} — the response was malformed. Please try again.`
    );
  }
};

// Keep the SDK migration local to the new transport. Other generation contracts
// still use the legacy adapter; never replay a stream after reading has begun.
export async function streamScript(
  systemInstruction: string,
  contents: string,
  onChunk: (text: string) => void,
  progress?: GenerationProgress,
): Promise<string> {
  const controller = new AbortController();
  const deadline = Date.now() + 120_000;
  const timeout = setTimeout(() => controller.abort(), 120_000);
  try {
    const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
    progress?.("generating", "Writing your new script.");
    const stream = await requestWithBusyRetry(async () => {
      controller.signal.throwIfAborted();
      return ai.models.generateContentStream({
        model: GENERATION_MODEL,
        contents,
        config: {
          systemInstruction,
          responseMimeType: "text/plain",
          abortSignal: controller.signal,
          // Retry only explicit 503 responses in our shared, bounded policy.
          httpOptions: { retryOptions: { attempts: 1 } },
        },
      });
    }, "stream", () => progress?.("provider_busy", "The writing service is busy. Retrying shortly."), deadline);
    let text = "";
    let finishReason: string | undefined;
    for await (const chunk of stream) {
      controller.signal.throwIfAborted();
      if (chunk.candidates?.[0]?.finishReason) finishReason = chunk.candidates[0].finishReason;
      if (chunk.text) {
        if (!text) progress?.("generating", "Writing your new script.");
        text += chunk.text;
        onChunk(chunk.text);
      }
    }
    if (finishReason !== "STOP" || !text.trim()) {
      throw ServiceUnavailable("The script stopped before it was complete. Nothing was saved. Please try again.");
    }
    return text;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    // Malformed framing, network loss and truncation remain failures with the
    // maintained SDK too. Preserve the existing draft and do not replay them.
    console.error(JSON.stringify({ event: "script_stream_interrupted", model: GENERATION_MODEL }));
    throw ServiceUnavailable("Generation was interrupted before a complete response arrived. Please try again.");
  } finally {
    clearTimeout(timeout);
  }
}
