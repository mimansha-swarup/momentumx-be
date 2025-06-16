import { GenerationConfig } from "@google/generative-ai";
import genAIModel from "../config/ai.js";


export const generateContent = (systemPrompt: string, userPrompt: string, generationConfig: GenerationConfig) => {
  const result = genAIModel(
    systemPrompt,
    generationConfig
  ).generateContent(userPrompt);
  return result;
};
export const generateStreamingContent = (
  systemPrompt: string,
  userPrompt: string,
  generationConfig: GenerationConfig
) => {
  const result = genAIModel(
    systemPrompt,
    generationConfig
  ).generateContentStream(userPrompt);
  return result;
};
