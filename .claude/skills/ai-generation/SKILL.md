---
name: ai-generation
description: Reference for Gemini AI generation patterns in MomentumX — models, configs, prompts, SSE streaming, embeddings, and KMeans clustering. Use when implementing or modifying any AI generation feature.
---

# AI Generation Reference

## Models

```typescript
// src/config/ai.ts
import { GoogleGenerativeAI } from '@google/generative-ai';

const genAI = new GoogleGenerativeAI(process.env.API_KEY!);

// Text generation — all content
export const genAIModel = () => genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

// Embeddings — topics only
export const embeddingModel = genAI.getGenerativeModel({ model: 'gemini-embedding-001' });
```

Use `genAIModel()` for all text generation. Use `embeddingModel` for embeddings only.

## Generation Configs

All configs in `src/constants/firebase.ts`:

```typescript
// Titles — JSON array of strings
export const GENERATION_CONFIG_TITLES = {
  responseMimeType: 'application/json',
  temperature: 0.9,
};

// Scripts — plain text streaming
export const GENERATION_CONFIG_SCRIPTS = {
  temperature: 0.8,
};

// Packaging — JSON object (title, description, thumbnail, hooks, shorts)
export const GENERATION_CONFIG_PACKAGING = {
  responseMimeType: 'application/json',
  temperature: 0.7,
};
```

**Rule:** Config must match what the prompt produces. Mixing them causes malformed output.

## Non-Streaming Generation

```typescript
async generateTitles(systemPrompt: string, userPrompt: string): Promise<string[]> {
  const model = genAIModel();
  const result = await model.generateContent({
    systemInstruction: systemPrompt,
    contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
    generationConfig: GENERATION_CONFIG_TITLES,
  });
  const text = result.response.text();
  return JSON.parse(text) as string[]; // always parse JSON responses
}
```

## Streaming Generation

```typescript
async generateScriptStream(systemPrompt: string, userPrompt: string) {
  const model = genAIModel();
  const result = await model.generateContentStream({
    systemInstruction: systemPrompt,
    contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
    generationConfig: GENERATION_CONFIG_SCRIPTS,
  });
  return result; // return stream handle to controller
}
```

## SSE Controller Pattern

```typescript
async streamScript(req: Request, res: Response) {
  try {
    // 1. Set headers and flush BEFORE any async work
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    // 2. Get stream
    const result = await this.contentService.generateScript(req.userId, req.params.scriptId);

    // 3. Stream chunks
    for await (const chunk of result.stream) {
      const text = chunk.text();
      if (text) res.write('data: ' + text + '\n\n');
    }

    // 4. End stream — both lines required
    res.write('data: [DONE]\n\n');
    res.end();
  } catch (error) {
    res.write('data: [ERROR]\n\n');
    res.end();
  }
}
```

## Prompt Variable Replacement

```typescript
import {
  TOPIC_SYSTEM_PROMPT,
  TOPIC_USER_PROMPT
} from '../constants/prompt';

// Replace all placeholders before calling Gemini
const userPrompt = TOPIC_USER_PROMPT
  .replace('{niche}', user.niche)
  .replace('{website}', user.website)
  .replace('{websiteContent}', user.websiteContent)
  .replace('{competitors}', user.competitors.join(', '))
  .replace('{targetAudience}', user.targetAudience)
  .replace('{userName}', user.name)
  .replace('{brandName}', user.brandName);

// Multiple occurrences — use regex
const prompt = PROMPT.replace(/{duration}/g, duration.toString());
```

Never call Gemini with unreplaced `{placeholder}` strings. If a variable is optional, substitute a fallback before calling replace:

```typescript
const website = user.website ?? 'no website provided';
const prompt = TOPIC_USER_PROMPT.replace('{website}', website);
```

## Embeddings

```typescript
async getEmbedding(text: string): Promise<number[]> {
  const result = await embeddingModel.embedContent(text);
  return result.embedding.values;
}

// Store with topic
const topic: Topic = {
  id: randomUUID(),
  title,
  embedding: await this.getEmbedding(title),
  createdBy: userId,
  createdAt: FieldValue.serverTimestamp(),
};
```

## KMeans Clustering

```typescript
import { getClusteredTitles } from '../utlils/content';

// Usage in topic generation
const pastTopics = await this.contentRepo.getTopicsByUserId(userId);
const clusteredSamples = getClusteredTitles(pastTopics);

// Feed cluster samples to Gemini to avoid repetitive suggestions
const avoidList = clusteredSamples.flat().map(t => t.title).join('\n');
```

`getClusteredTitles` internals (in `src/utlils/content.ts`):
```typescript
const k = Math.min(8, Math.ceil(titleRecord.length / 20));
if (titles.length <= k) return [titles]; // guard — clustering with k > n throws
// kmeans clustering on embeddings...
```

## Packaging Generation Pattern

Each asset is a separate call:

```typescript
// generate-title endpoint
async generateTitle(script: string, userId: string) {
  const model = genAIModel();
  const result = await model.generateContent({
    systemInstruction: PACKAGING_SYSTEM_PROMPT,
    contents: [{ role: 'user', parts: [{ text: GENERATE_TITLE_PROMPT.replace('{script}', script) }] }],
    generationConfig: GENERATION_CONFIG_PACKAGING,
  });
  const text = result.response.text();
  return JSON.parse(text); // always parse
}
```

## Current Prompt Keys

```typescript
// src/constants/prompt.ts
TOPIC_SYSTEM_PROMPT       // title generation system persona
TOPIC_USER_PROMPT         // title generation context + channel data
SCRIPT_SYSTEM_PROMPT      // script writing system persona
SCRIPT_USER_PROMPT        // script title + user context
PACKAGING_SYSTEM_PROMPT   // packaging expert system persona
GENERATE_TITLE_PROMPT     // title variations prompt
GENERATE_DESCRIPTION_PROMPT  // SEO description prompt
GENERATE_THUMBNAIL_PROMPT    // thumbnail brief prompt
GENERATE_HOOKS_PROMPT        // hooks prompt
GENERATE_SHORTS_PROMPT       // shorts script prompt
```
