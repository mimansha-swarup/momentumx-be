import genAIModel from "../config/ai.js";
import { ServiceUnavailable } from "./errors.js";
export const generateContent = async (systemPrompt, userPrompt, generationConfig, mimeType, inlineData) => {
    const blob = new Blob([inlineData], { type: mimeType });
    const arrayBuffer = await blob.arrayBuffer();
    const base64Text = btoa(String.fromCharCode(...new Uint8Array(arrayBuffer)));
    const result = genAIModel(systemPrompt, generationConfig).generateContentStream({
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
    }, { timeout: STREAM_TIMEOUT_MS });
    return result;
};
// Bounds the whole Gemini request (connect + stream). Without it a stalled
// upstream connection hangs the SSE client forever with no error to react to.
const STREAM_TIMEOUT_MS = 120000;
export const generateStreamingContent = (systemPrompt, userPrompt, generationConfig) => {
    const result = genAIModel(systemPrompt, generationConfig).generateContentStream(userPrompt, { timeout: STREAM_TIMEOUT_MS });
    return result;
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
export const collectJson = async (result, label) => {
    let accumulated = "";
    try {
        for await (const chunk of result.stream) {
            const part = chunk.text();
            if (part)
                accumulated += part;
        }
    }
    catch (streamError) {
        console.error(JSON.stringify({
            event: "ai_stream_failed",
            label,
            message: streamError?.message,
        }));
        throw ServiceUnavailable(`Couldn't generate ${label} — the request was interrupted. Please try again.`);
    }
    if (!accumulated.trim()) {
        console.error(JSON.stringify({ event: "ai_empty_response", label }));
        throw ServiceUnavailable(`Couldn't generate ${label} — nothing came back. Please try again.`);
    }
    try {
        return JSON.parse(accumulated);
    }
    catch (parseError) {
        console.error(JSON.stringify({
            event: "ai_malformed_json",
            label,
            length: accumulated.length,
            // Both ends: the head shows the shape, the tail shows truncation.
            head: accumulated.slice(0, 200),
            tail: accumulated.slice(-200),
            message: parseError?.message,
        }));
        throw ServiceUnavailable(`Couldn't generate ${label} — the response was malformed. Please try again.`);
    }
};
