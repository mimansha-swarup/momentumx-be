import genAIModel from "../config/ai.js";
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
