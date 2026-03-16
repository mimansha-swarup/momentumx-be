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

// 2. Stream chunks with error recovery
try {
  for await (const chunk of result.stream) {
    const text = chunk.text();
    if (text) res.write('data: ' + text + '\n\n');
  }
} catch (streamError) {
  console.error("SSE stream error", streamError);
} finally {
  // 3. End stream — always fires, even on error
  res.write('data: [DONE]\n\n');
  res.end();
}

// 4. Post-stream work (save to DB) in separate try/catch
try {
  await saveScript(...);
} catch (saveError) {
  console.error("Post-stream save error", saveError);
}
```

Non-negotiable:
- `res.flushHeaders()` must be called before the streaming loop
- `res.write('data: [DONE]\n\n')` and `res.end()` must be in a `finally` block
- Stream errors must NOT leave the client hanging — `finally` guarantees termination
- Post-stream saves (Firestore writes) must be in a separate try/catch — a save failure must not affect the already-completed stream
- Every text chunk sent as `data: <text>\n\n`

---

## KMeans — Guards and Preprocessing

```typescript
// 1. Filter archived topics and cap at 200
const activeTitles = (titleRecord || []).filter((doc) => !doc.archived);
const capped = activeTitles.slice(0, 200);

// 2. Calculate k
const k = Math.min(8, Math.ceil(capped.length / 20));

// 3. Guard — skip clustering if too few titles
if (titles.length <= k) return [titles];
```

Non-negotiable:
- Always filter out archived topics before clustering
- Cap at 200 topics to prevent KMeans timeout on Vercel
- Guard `titles.length <= k` prevents clustering crash when `k > n`
- Never remove any of these guards

All KMeans logic is in `src/utlils/content.ts` → `getClusteredTitles`.

---

## Prompt and Config Ownership

- `src/constants/prompt.ts` — only AI Engineer modifies
- `src/constants/firebase.ts` — only AI Engineer modifies
- Developer wires the endpoints; AI Engineer owns the generation logic inside services
