---
name: ai-generation-patterns
description: Rules for Gemini usage, prompt variables, SSE streaming, and KMeans clustering in MomentumX.
---

# AI Generation Patterns

Rules for working with Gemini, prompts, SSE streaming, and embeddings. Ensures AI generation is consistent, debuggable, and doesn't break silently.

---

## Two Models — Use the Right One

```
GENERATION_MODEL     → text generation (default gemini-3.8-flash)
gemini-embedding-001  → embeddings only (ideas for KMeans)
```

Both initialized in `src/config/ai.ts`. Use the factory functions — never initialize `GoogleGenerativeAI` directly in services.

---

## Generation Config Must Match Output Format

```
GENERATION_CONFIG_IDEAS             → {concept, workingTitle, type, evidence}[] (responseSchema-enforced; step-1 idea generation)
GENERATION_CONFIG_SCRIPTS           → plain text (text/plain, streamed via SSE)
GENERATION_CONFIG_HOOKS             → {hooks: string[5]} (responseSchema-enforced)
GENERATION_CONFIG_PREFILL           → {niche, targetAudience, brandName} (responseSchema-enforced)
GENERATION_CONFIG_TITLE_VARIATIONS  → {titles: [{title, characterCount?, score, reason}]} (responseSchema-enforced; post-script Title step)
GENERATION_CONFIG_DESCRIPTION       → SEO description (responseSchema-enforced; packaging step)
GENERATION_CONFIG_THUMBNAIL         → thumbnail brief (responseSchema-enforced; packaging step)
GENERATION_CONFIG_SHORTS            → {segments, totalDuration} (responseSchema-enforced; packaging step)
```

**Critical:** Never use a JSON config with a plain text prompt — Gemini will return malformed output that breaks `JSON.parse`.

**Every JSON config defines a `responseSchema`** (see `GENERATION_CONFIG_IDEAS` for the pattern) — schema-enforced structured output is the strongest guarantee against malformed JSON, and there are no schema-less JSON configs left. Bound array lengths (`minItems`/`maxItems`) wherever the prompt fixes the count, so a short generation fails at the model instead of persisting a partial slate — but never invent a bound the prompt doesn't state; an over-tight schema turns graceful degradation into a hard failure.

**Drain and parse every JSON generation with `collectJson`** (`src/utlils/ai.ts`), never an inline `JSON.parse`. It handles the three real failure modes — blocked stream, empty body, unparseable body — as a 503 with a safe failure message, with a structured log naming which one it was. A raw `JSON.parse` throws a `SyntaxError` that the error handler masks as "Something went wrong".

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

## Always Parse JSON Responses — Through `collectJson`, Never Inline

```typescript
// ✅ The only way JSON generations are drained and parsed
const result = await collectJson<TitleVariations>(stream, "title-variations");

// ❌ This section used to prescribe exactly this, contradicting the rule above
const result = JSON.parse(accumulatedRes);
```

`collectJson` (`src/utlils/ai.ts`) handles the three real failure modes — blocked
stream, empty body, unparseable body — as a **503 with a safe failure message**, with a
structured log naming which one it was. A raw `JSON.parse` throws a `SyntaxError`
that the error handler masks as "Something went wrong". No service does an inline
parse today; this section described a practice the codebase had already retired.

A parse failure can also reflect interrupted or malformed provider output. Inspect the
response and prompt/config before changing them;
do not swallow the error and do not add "repair" heuristics on top of malformed
output.

---

## Research-Grounded Generation

`ResearchContextService` (`research-context.service.ts`) is the shared research engine: it fetches trending + keyword-ranked videos from YouTube, cleans the pool (drops Shorts/livestream junk, dedupes, caps 2 titles per channel), and annotates titles with real view counts.

- **Idea generation (step 1)** injects `getIdeaSignals(niche)` into `IDEA_USER_PROMPT`'s `{researchSignals}` slot — ideas cite grounding in their `evidence` field.
- **Title step (post-script)** injects `getTitleSignals(workingTitle)` into `GENERATE_TITLE_PROMPT` and returns scored variations via `GENERATION_CONFIG_TITLE_VARIATIONS`.
- **Degradation contract (non-negotiable):** research is an enhancer, never a gate — every signal fetch failure resolves to an empty block and generation proceeds on channel context alone. Never let a YouTube error propagate out of `ResearchContextService`.


---

## SSE Streaming

Match the endpoint's actual protocol in `docs/api-communication.md` and the script API
reference. Initial script GET uses JSON-encoded chunks plus raw `[DONE]`; opt-in POST
streams use named events and no `[DONE]`. Initial SSE auth accepts Bearer with query-token
compatibility and derives channel membership from the project. Validate before flushing
headers; close an opened stream on every outcome. Persistence and accounting precede
final success; never prescribe saving after signaling a completed result. Interrupted
output must preserve the previous manuscript. A client disconnect is an unknown outcome,
not authorization to replay generation.

---

## KMeans — Guards and Preprocessing

The repository filters archived channel ideas and bounds the pool; the utility
calculates and guards clustering. `accountId` scopes access, not `createdBy`.

```typescript
// 1+2. Filter archived and cap at 200 — IN THE QUERY, not in memory.
//      src/repository/content.repository.ts → getIdeasForClustering()
db.collection(COLLECTIONS.IDEAS)
  .where("accountId", "==", accountId)  // ← tenancy: the CHANNEL, not the author
  .where("archived", "==", false)   // ← archived filter
  .limit(200)                        // ← the cap
  .select("title", "embedding")      // projected: never read whole idea docs
  .get();

// 3. Calculate k — src/utlils/content.ts → getClusteredTitles()
const k = Math.min(8, Math.ceil(capped.length / 20));

// 4. Guard — skip clustering if too few titles (same file)
if (titles.length <= k) return [titles];
```

Non-negotiable:
- Always filter out archived ideas before clustering
- Cap at 200 ideas to prevent KMeans timeout on Vercel
- Guard `titles.length <= k` prevents clustering crash when `k > n`
- Never remove any of these guards

**Where each one lives:**

| Guard | Enforced in |
|---|---|
| archived filter | `content.repository.ts` → `getIdeasForClustering` (query) |
| 200 cap | `content.repository.ts` → `getIdeasForClustering` (query) |
| `k` calculation | `utlils/content.ts` → `getClusteredTitles` |
| `titles.length <= k` skip | `utlils/content.ts` → `getClusteredTitles` |

`getClusteredTitles` clusters whatever the repository hands it, **untouched** — it
does no filtering and no slicing of its own. So weakening the query silently
removes two guards with no change to the util and no type error. Both are pinned
by `tests/unit/repository/content.repository.behaviour.test.ts`; if you change
that query, those tests are the ones that must still pass.

---

## Prompt and Config Ownership

- `src/constants/prompt.ts` — only AI Engineer modifies
- `src/constants/firebase.ts` — only AI Engineer modifies
- Developer wires the endpoints; AI Engineer owns the generation logic inside services
