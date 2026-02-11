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
    });
    return result;
};
export const generateStreamingContent = (systemPrompt, userPrompt, generationConfig) => {
    const result = genAIModel(systemPrompt, generationConfig).generateContentStream(userPrompt);
    return result;
};
