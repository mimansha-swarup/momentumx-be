import { GenerationConfig, SchemaType } from "@google/generative-ai";

// Idea generation (step 1): concepts, not headlines. Schema-enforced.
// Exactly 10 — IDEA_SYSTEM_PROMPT mandates 10 (5 long, 5 short) and the batch
// UI is built around a full slate. `evidence` stays optional on purpose:
// research signals may be unavailable and the prompt forbids fabricating them.
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
    minItems: 10,
    maxItems: 10,
  },
};

export const GENERATION_CONFIG_SCRIPTS: GenerationConfig = {
  responseMimeType: "text/plain",
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

// Shorts generation (packaging): longest JSON packaging output, so the most
// exposed to truncation/malformed JSON — schema-enforced to match the canonical
// { segments, totalDuration } shape. Segment COUNT is duration-dependent
// (GENERATE_SHORTS_PROMPT: ~2 for 15s, ~3 for 30s, ~5 for 60s), so only a lower
// bound: an empty segments array is rejected downstream anyway
// (packaging.service.ts isEmptyField) — better to fail generation than persist it.
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
        minItems: 1,
      },
      totalDuration: { type: SchemaType.STRING },
    },
    required: ["segments", "totalDuration"],
  },
};

// Description generation (packaging): schema-enforced to match the canonical
// { description } shape — never a bare string or a differently-keyed object.
export const GENERATION_CONFIG_DESCRIPTION: GenerationConfig = {
  responseMimeType: "application/json",
  responseSchema: {
    type: SchemaType.OBJECT,
    properties: {
      description: { type: SchemaType.STRING },
    },
    required: ["description"],
  },
};

// Thumbnail brief generation (packaging): schema-enforced to match the canonical
// { descriptions } shape, exactly 3 — GENERATE_THUMBNAIL_PROMPT asks for THREE
// distinct visual approaches and the UI renders three brief slots.
export const GENERATION_CONFIG_THUMBNAIL: GenerationConfig = {
  responseMimeType: "application/json",
  responseSchema: {
    type: SchemaType.OBJECT,
    properties: {
      descriptions: {
        type: SchemaType.ARRAY,
        items: { type: SchemaType.STRING },
        minItems: 3,
        maxItems: 3,
      },
    },
    required: ["descriptions"],
  },
};

// Hooks generation: hook text routinely contains quotation marks (the system
// prompt's own style examples are quoted sentences), which under a schema-less
// JSON config came back unescaped and broke JSON.parse in production.
// Schema-enforced to the canonical { hooks } shape, exactly 5 distinct alternatives
// in HOOKS_SYSTEM_PROMPT.
export const GENERATION_CONFIG_HOOKS: GenerationConfig = {
  responseMimeType: "application/json",
  responseSchema: {
    type: SchemaType.OBJECT,
    properties: {
      hooks: {
        type: SchemaType.ARRAY,
        items: { type: SchemaType.STRING },
        minItems: 5,
        maxItems: 5,
      },
    },
    required: ["hooks"],
  },
};

// Post-script Title step: exactly 3 scored variations — GENERATE_TITLE_PROMPT
// asks for THREE and TitlesCard renders three slots. `characterCount` is
// deliberately NOT required: nothing reads it (the UI computes it from
// title.length), so requiring it would only add a way for generation to fail.
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
        minItems: 3,
        maxItems: 3,
      },
    },
    required: ["titles"],
  },
};

