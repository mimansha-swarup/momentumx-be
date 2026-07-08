---
name: ai-generation-patterns
description: Rules for Gemini usage, prompt variables, SSE streaming, and KMeans clustering in MomentumX.
---

# AI Generation Patterns

Rules for working with Gemini, prompts, SSE streaming, and embeddings. Ensures AI generation is consistent, debuggable, and doesn't break silently.

---

## Two Models — Use the Right One

```
gemini-3.5-flash      → all text/content generation
gemini-embedding-001  → embeddings only (topics for KMeans)
```

Both initialized in `src/config/ai.ts`. Use the factory functions — never initialize `GoogleGenerativeAI` directly in services.

---

## Generation Config Must Match Output Format

```
GENERATION_CONFIG_IDEAS             → {concept, workingTitle, type, evidence}[] (responseSchema-enforced; step-1 idea generation)
GENERATION_CONFIG_TITLES            → string[] (responseSchema-enforced)
GENERATION_CONFIG_SCRIPTS           → plain text (text/plain, streamed via SSE)
GENERATION_CONFIG_PACKAGING         → JSON object (MIME type only, no schema)
GENERATION_CONFIG_TITLE_VARIATIONS  → {titles: [{title, characterCount?, score, reason}]} (responseSchema-enforced; post-script Title step)
```

**Critical:** Never use a JSON config with a plain text prompt — Gemini will return malformed output that breaks `JSON.parse`.

**New JSON configs must define a `responseSchema`** (see `GENERATION_CONFIG_IDEAS` for the pattern) — schema-enforced structured output is the strongest guarantee against malformed JSON. `GENERATION_CONFIG_PACKAGING` predates this and relies on MIME type alone; don't copy that for new configs.

Configs are in `src/constants/firebase.ts`. Only AI Engineer modifies this file.

---

## Prompt Variables — Always `{placeholder}` Syntax

```typescript
// ✅ Untrusted values (script, title, niche, hook, research signals):
//    use fillTemplate — String.replace expands $&, $', $`, $$ in the VALUE,
//    so a script containing "$&" would silently corrupt the prompt.
fillTemplate(PROMPT, { "{script}": script, "{title}": title })

// ✅ Trusted constant substitutions may stay on .replace
PROMPT.replace("{videoFormatStyle}", SCRIPT_FORMAT_STYLE[format])

// ❌ Never feed user/external content straight into .replace's second arg
PROMPT.replace("{script}", script)   // $-patterns in `script` corrupt output

// ❌ Never leave unreplaced placeholders
// If a variable is optional, handle it before fill, not after
```

`fillTemplate` (`src/utlils/prompt-blocks.ts`) inserts each value verbatim via
split/join and replaces **all** occurrences of a token (so it also subsumes the
old `/{token}/g` sites). Prompts live in `src/constants/prompt.ts`. Only AI
Engineer modifies that file.

---

## Always Parse JSON Responses

```typescript
// Gemini returns JSON as a string — always parse (packaging, titles, scoring)
const result = JSON.parse(accumulatedRes);
```

If `JSON.parse` throws, the prompt or config is misconfigured — fix the prompt/config, do not swallow the error and do not add "repair" heuristics on top of malformed output.

---

## Research-Grounded Generation (phase 2)

`ResearchContextService` (`research-context.service.ts`) is the shared research engine: it fetches trending + keyword-ranked videos from YouTube, cleans the pool (drops Shorts/livestream junk, dedupes, caps 2 titles per channel), and annotates titles with real view counts.

- **Idea generation (step 1)** injects `getIdeaSignals(niche)` into `IDEA_USER_PROMPT`'s `{researchSignals}` slot — ideas cite grounding in their `evidence` field.
- **Title step (post-script)** injects `getTitleSignals(workingTitle)` into `GENERATE_TITLE_PROMPT` and returns scored variations via `GENERATION_CONFIG_TITLE_VARIATIONS`.
- **Degradation contract (non-negotiable):** research is an enhancer, never a gate — every signal fetch failure resolves to an empty block and generation proceeds on channel context alone. Never let a YouTube error propagate out of `ResearchContextService`.

(The former standalone `/v1/title-intelligence` pipelines were retired in phase 2; their machinery was absorbed into the above.)

---

## SSE Streaming — Exact Pattern, No Deviations

```typescript
// 1. Set headers and flush FIRST
res.setHeader('Content-Type', 'text/event-stream');
res.setHeader('Cache-Control', 'no-cache');
res.setHeader('Connection', 'keep-alive');
res.flushHeaders();

// 2. Stream chunks with error recovery.
//    JSON.stringify each chunk so embedded newlines can't break SSE framing
//    (a raw multi-line chunk would be split into multiple SSE events).
//    The client must JSON.parse each `data:` line (except the [DONE] sentinel).
try {
  for await (const chunk of result.stream) {
    const text = chunk.text();
    if (text) res.write('data: ' + JSON.stringify(text) + '\n\n');
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
- Every text chunk is **JSON-encoded**: `data: ${JSON.stringify(text)}\n\n` (NOT raw `data: <text>`). This keeps multi-line content (scripts) from corrupting the SSE frame. The `[DONE]` terminator is the one exception — sent raw. Clients `JSON.parse` each `data:` line and stop on the literal `[DONE]`.

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
