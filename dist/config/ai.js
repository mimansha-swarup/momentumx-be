import { GoogleGenerativeAI } from "@google/generative-ai";
const apiKey = process.env.API_KEY;
if (!apiKey) {
    throw new Error("API_KEY environment variable is required");
}
const genAI = new GoogleGenerativeAI(apiKey);
// One explicit model for every generation path; never silently change models
// during retries. Embeddings use their own fixed model below.
export const GENERATION_MODEL = (process.env.GENERATION_MODEL ?? "gemini-3.8-flash").trim();
if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(GENERATION_MODEL)) {
    throw new Error("GENERATION_MODEL must be a nonempty model ID, without a URL or models/ prefix");
}
const genAIModel = (systemPrompt, generationConfig) => genAI.getGenerativeModel({
    model: GENERATION_MODEL,
    systemInstruction: systemPrompt,
    generationConfig,
});
export const embeddingModel = genAI.getGenerativeModel({
    model: "gemini-embedding-001",
});
export default genAIModel;
