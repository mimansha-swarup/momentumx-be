import { GenerationConfig, SchemaType } from "@google/generative-ai";

// Idea generation (step 1): concepts, not headlines. Schema-enforced.
export const GENERATION_CONFIG_IDEAS: GenerationConfig = {
  responseMimeType: "application/json",
  responseSchema: {
    type: SchemaType.ARRAY,
    items: {
      type: SchemaType.OBJECT,
      properties: {
        concept: { type: SchemaType.STRING },
        workingTitle: { type: SchemaType.STRING },
        type: { type: SchemaType.STRING, enum: ["long", "short"], format: "enum" },
        evidence: { type: SchemaType.STRING },
      },
      required: ["concept", "workingTitle", "type"],
    },
  },
};

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

// Onboarding prefill (Phase 3.2): infer niche/audience/brand from channel signals. Schema-enforced.
export const GENERATION_CONFIG_PREFILL: GenerationConfig = {
  responseMimeType: "application/json",
  responseSchema: {
    type: SchemaType.OBJECT,
    properties: {
      niche: { type: SchemaType.STRING },
      targetAudience: { type: SchemaType.STRING },
      brandName: { type: SchemaType.STRING },
    },
    required: ["niche", "targetAudience", "brandName"],
  },
};

// Shorts generation (packaging): longest JSON packaging output, most exposed
// to truncation/malformed JSON under GENERATION_CONFIG_PACKAGING's no-schema
// mode — schema-enforced to match the canonical { segments, totalDuration } shape.
export const GENERATION_CONFIG_SHORTS: GenerationConfig = {
  responseMimeType: "application/json",
  responseSchema: {
    type: SchemaType.OBJECT,
    properties: {
      segments: {
        type: SchemaType.ARRAY,
        items: {
          type: SchemaType.OBJECT,
          properties: {
            startTime: { type: SchemaType.STRING },
            endTime: { type: SchemaType.STRING },
            content: { type: SchemaType.STRING },
            type: {
              type: SchemaType.STRING,
              enum: ["hook", "point", "transition", "cta"],
              format: "enum",
            },
          },
          required: ["startTime", "endTime", "content", "type"],
        },
      },
      totalDuration: { type: SchemaType.STRING },
    },
    required: ["segments", "totalDuration"],
  },
};

// Post-script Title step: 3 scored variations. Schema-enforced.
export const GENERATION_CONFIG_TITLE_VARIATIONS: GenerationConfig = {
  responseMimeType: "application/json",
  responseSchema: {
    type: SchemaType.OBJECT,
    properties: {
      titles: {
        type: SchemaType.ARRAY,
        items: {
          type: SchemaType.OBJECT,
          properties: {
            title: { type: SchemaType.STRING },
            characterCount: { type: SchemaType.NUMBER },
            score: { type: SchemaType.NUMBER },
            reason: { type: SchemaType.STRING },
          },
          required: ["title", "score", "reason"],
        },
      },
    },
    required: ["titles"],
  },
};

