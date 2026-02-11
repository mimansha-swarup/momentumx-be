import { SchemaType } from "@google/generative-ai";
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
