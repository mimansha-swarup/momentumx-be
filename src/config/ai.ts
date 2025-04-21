import { GenerationConfig, GoogleGenerativeAI } from "@google/generative-ai";

const genAI = new GoogleGenerativeAI(process.env.API_KEY);
const genAIModel = (systemPrompt: string, generationConfig: GenerationConfig) =>
  genAI.getGenerativeModel({
    model: "gemini-2.0-flash",
    systemInstruction: systemPrompt,
    generationConfig
  });

export default genAIModel;
