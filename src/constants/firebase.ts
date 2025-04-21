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
