import genAIModel from "../config/ai";

export const generateContent = (systemPrompt: string, userPrompt: string) => {
  const result = genAIModel(systemPrompt).generateContent(userPrompt);
  return result;
};
