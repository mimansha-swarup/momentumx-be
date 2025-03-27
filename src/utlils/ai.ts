import genAIModel from "../config/ai";

export const generateContent = (systemPrompt: string, userPrompt: string) => {
  const result = genAIModel.generateContent([systemPrompt, userPrompt]);
  return result;
};
