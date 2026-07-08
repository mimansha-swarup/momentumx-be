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
// Post-script Title step: 3 scored variations. Schema-enforced.
export const GENERATION_CONFIG_TITLE_VARIATIONS = {
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
