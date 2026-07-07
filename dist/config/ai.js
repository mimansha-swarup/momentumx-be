import { GoogleGenerativeAI } from "@google/generative-ai";
const apiKey = process.env.API_KEY;
if (!apiKey) {
    throw new Error("API_KEY environment variable is required");
}
const genAI = new GoogleGenerativeAI(apiKey);
const genAIModel = (systemPrompt, generationConfig) => genAI.getGenerativeModel({
    model: "gemini-3.5-flash",
    systemInstruction: systemPrompt,
    generationConfig,
});
export const embeddingModel = genAI.getGenerativeModel({
    model: "gemini-embedding-001",
});
export default genAIModel;
