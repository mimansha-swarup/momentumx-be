import { SchemaType } from "@google/generative-ai";
// Idea generation (step 1): concepts, not headlines. Schema-enforced.
export const GENERATION_CONFIG_IDEAS = {
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
export const GENERATION_CONFIG_TITLES = {
    responseMimeType: "application/json",
    responseSchema: {
        type: SchemaType.ARRAY,
        items: {
            type: SchemaType.STRING,
        },
    },
};
export const GENERATION_CONFIG_SCRIPTS = {
    responseMimeType: "text/plain",
};
export const GENERATION_CONFIG_PACKAGING = {
    responseMimeType: "application/json",
};
export const GENERATION_CONFIG_SCORED_TITLES = {
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
export const GENERATION_CONFIG_SMART_TITLES = {
    responseMimeType: "application/json",
    responseSchema: {
        type: SchemaType.OBJECT,
        properties: {
            analysis: {
                type: SchemaType.OBJECT,
                properties: {
                    topic: { type: SchemaType.STRING },
                    keywords: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
                    emotion: { type: SchemaType.STRING },
                    intent: { type: SchemaType.STRING },
                },
                required: ["topic", "keywords", "emotion", "intent"],
            },
            patterns: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
            titles: {
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
        },
        required: ["analysis", "patterns", "titles"],
    },
};
