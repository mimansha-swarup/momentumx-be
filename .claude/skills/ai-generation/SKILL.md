---
name: ai-generation
description: Reference for Gemini AI generation in MomentumX — model factory, generation helpers, configs, prompt replacement, SSE, embeddings, and clustering. Use when implementing or modifying any AI generation feature.
---

# AI Generation Reference

Code-level "how" for this repo. The enforced rules (config↔format matching, SSE non-negotiables, KMeans guards, file ownership) live in `.claude/rules/ai-generation-patterns.md` — this file shows the actual call shapes.

## Model Factory (`src/config/ai.ts`)

```typescript
// The factory takes the system prompt and config — NOT a no-arg call
const genAIModel = (systemPrompt: string, generationConfig: GenerationConfig) =>
  genAI.getGenerativeModel({
    model: "gemini-3.5-flash",
    systemInstruction: systemPrompt,
    generationConfig,
  });
export default genAIModel;

export const embeddingModel = genAI.getGenerativeModel({
  model: "gemini-embedding-001",
});
```

`API_KEY` env var holds the Gemini key. Never instantiate `GoogleGenerativeAI` in a service — go through the factory.

## Generation Helpers (`src/utlils/ai.ts`)

Services do not call the model directly; they use these:

```typescript
// Text-only streaming generation — the workhorse
generateStreamingContent(systemPrompt, userPrompt, generationConfig)
// → returns the stream handle from generateContentStream(userPrompt)

// Multimodal generation with inline data (base64-encoded blob attached to the user turn)
generateContent(systemPrompt, userPrompt, generationConfig, mimeType, inlineData)
```

Both return a streaming result. Two consumption patterns:

```typescript
// A. Stream to the client (scripts, SSE)
for await (const chunk of result.stream) {
  const text = chunk.text();
  if (text) res.write(`data: ${JSON.stringify(text)}\n\n`); // chunks are ALWAYS JSON-encoded
}

// B. Accumulate then parse (titles, packaging, scoring — anything JSON)
let acc = "";
for await (const chunk of result.stream) acc += chunk.text();
const parsed = JSON.parse(acc); // always parse; a throw means prompt/config mismatch
```

For the full SSE controller pattern (headers, flush, try/catch/finally, `[DONE]`, post-stream save) follow `.claude/rules/ai-generation-patterns.md` exactly — the live reference is the script streaming flow in `src/service/content.service.ts`.

## Generation Configs (`src/constants/firebase.ts`)

Real configs — they use `responseSchema` structured output, not temperature tuning:

```typescript
GENERATION_CONFIG_TITLES         // responseMimeType: 'application/json' + schema: ARRAY of STRING
GENERATION_CONFIG_SCRIPTS        // responseMimeType: 'text/plain'
GENERATION_CONFIG_PACKAGING      // responseMimeType: 'application/json' (no schema — legacy, don't copy)
GENERATION_CONFIG_SCORED_TITLES  // schema: ARRAY of {title, score, reason}
GENERATION_CONFIG_SMART_TITLES   // schema: {analysis{topic,keywords,emotion,intent}, patterns[], titles[]}
```

New JSON configs must define a `responseSchema` (copy the `GENERATION_CONFIG_SCORED_TITLES` shape).

## Prompt Variable Replacement

```typescript
const userPrompt = TOPIC_USER_PROMPT
  .replace('{niche}', user.niche)
  .replace('{competitors}', user.competitors.join(', '))
  .replace('{targetAudience}', user.targetAudience);

// Multiple occurrences — regex
const prompt = PROMPT.replace(/{duration}/g, duration.toString());

// Optional variables — substitute a fallback BEFORE replace
const website = user.website ?? 'no website provided';
```

Never call Gemini with unreplaced `{placeholder}` strings.

## Current Prompt Keys (`src/constants/prompt.ts`)

```
TOPIC_SYSTEM_PROMPT / TOPIC_USER_PROMPT            — topic/title generation (9 hook archetypes)
SCRIPT_SYSTEM_PROMPT / SCRIPT_USER_PROMPT          — documentary-style script, retention framework
PACKAGING_SYSTEM_PROMPT                            — packaging expert persona
GENERATE_TITLE_PROMPT / GENERATE_DESCRIPTION_PROMPT / GENERATE_THUMBNAIL_PROMPT
GENERATE_HOOKS_PROMPT / GENERATE_SHORTS_PROMPT     — per-asset packaging prompts
HOOKS_SYSTEM_PROMPT                                — hook writer (first 5–10 seconds)

// Title intelligence (/v1/title-intelligence)
GENERATE_SCORED_TITLES_SYSTEM_PROMPT / _USER_PROMPT   — single-pass generate + score
ANALYZE_CONTENT_SYSTEM_PROMPT / _USER_PROMPT          — deep-generate step 1: extract metadata
FIND_PATTERNS_SYSTEM_PROMPT / _USER_PROMPT            — step 2: patterns from niche titles
GENERATE_ENRICHED_TITLES_SYSTEM_PROMPT / _USER_PROMPT — step 3: 20 candidates
SCORE_TITLES_SYSTEM_PROMPT / _USER_PROMPT             — step 4: score, return top 10
```

Deep-generate steps chain: each step's output fills the next step's `{placeholders}` — keep field names aligned across steps when editing.

## Embeddings

```typescript
// src/utlils/content.ts
const embedding = await embeddingModel.embedContent(title);
// embedding.embedding.values → number[], stored on the topic document
```

## KMeans Clustering (`src/utlils/content.ts` → `getClusteredTitles`)

Groups past titles by embedding so generation prompts can show "avoid these patterns" samples per cluster. Guards (filter archived, cap 200, `k = min(8, ceil(n/20))`, skip when `n <= k`) are non-negotiable — see the rules file.
