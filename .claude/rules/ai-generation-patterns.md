---
name: ai-generation-patterns
description: Rules for Gemini usage, prompt variables, SSE streaming, and KMeans clustering in MomentumX.
---

# AI Generation Patterns

Rules for working with Gemini, prompts, SSE streaming, and embeddings. Ensures AI generation is consistent, debuggable, and doesn't break silently.

---

## Two Models — Use the Right One

```
gemini-2.0-flash      → all text/content generation
gemini-embedding-001  → embeddings only (topics for KMeans)
```

Both initialized in `src/config/ai.ts`. Use the factory functions — never initialize `GoogleGenerativeAI` directly in services.

---

## Generation Config Must Match Output Format

```
JSON array output   → GENERATION_CONFIG_TITLES
Plain text output   → GENERATION_CONFIG_SCRIPTS
JSON object output  → GENERATION_CONFIG_PACKAGING
```

**Critical:** Never use a JSON config with a plain text prompt — Gemini will return malformed output that breaks `JSON.parse`.

Configs are in `src/constants/firebase.ts`. Only AI Engineer modifies this file.

---

## Prompt Variables — Always `{placeholder}` Syntax

```typescript
// ✅ Consistent convention
PROMPT.replace('{script}', script).replace('{title}', title)

// Multiple occurrences — use regex replace
PROMPT.replace(/{duration}/g, duration.toString())

// ❌ Never leave unreplaced placeholders
// If a variable is optional, handle it before replace, not after
```

Prompts live in `src/constants/prompt.ts`. Only AI Engineer modifies this file.

---

## Always Parse Packaging Responses

```typescript
// Gemini returns JSON as a string — always parse
const result = JSON.parse(accumulatedRes);
```

If `JSON.parse` throws, the prompt or config is misconfigured — fix the prompt, do not swallow the error.

---

## SSE Streaming — Exact Pattern, No Deviations

```typescript
// 1. Set headers and flush FIRST
res.setHeader('Content-Type', 'text/event-stream');
res.setHeader('Cache-Control', 'no-cache');
res.setHeader('Connection', 'keep-alive');
res.flushHeaders();

// 2. Stream chunks
for await (const chunk of result.stream) {
  const text = chunk.text();
  if (text) res.write('data: ' + text + '\n\n');
}

// 3. End stream — both lines required
res.write('data: [DONE]\n\n');
res.end();
```

Non-negotiable:
- `res.flushHeaders()` must be called before the streaming loop
- `res.write('data: [DONE]\n\n')` always ends the stream
- `res.end()` always follows
- Every text chunk sent as `data: <text>\n\n`

---

## KMeans Guard — Always Check Before Clustering

```typescript
if (titles.length <= k) return [titles]; // skip clustering
```

Clustering with `k > n` throws. This guard is non-negotiable — never remove it.

`k = Math.min(8, Math.ceil(titleRecord.length / 20))` — this calculation is in `src/utlils/content.ts`.

---

## Prompt and Config Ownership

- `src/constants/prompt.ts` — only AI Engineer modifies
- `src/constants/firebase.ts` — only AI Engineer modifies
- Developer wires the endpoints; AI Engineer owns the generation logic inside services
