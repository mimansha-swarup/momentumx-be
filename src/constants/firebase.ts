import { GenerationConfig, SchemaType } from "@google/generative-ai";

export const GENERATION_CONFIG_TITLES: GenerationConfig = {
  responseMimeType: "application/json",
  responseSchema: {
    type: SchemaType.ARRAY,
    items: {
      type: SchemaType.STRING,
    },
  },
};

export const GENERATION_CONFIG_SCRIPTS: GenerationConfig = {
  responseMimeType: "text/plain",
};

export const GENERATION_CONFIG_PACKAGING: GenerationConfig = {
  responseMimeType: "application/json",
};

export const GENERATION_CONFIG_SCORED_TITLES: GenerationConfig = {
  responseMimeType: "application/json",
  responseSchema: {
    type: SchemaType.ARRAY,
    items: {
      type: SchemaType.OBJECT,
      properties: {
        title: { type: SchemaType.STRING },
        score: { type: SchemaType.NUMBER },
        reason: { type: SchemaType.STRING },
      },
      required: ["title", "score", "reason"],
    },
  },
};
