---
name: ai-generation
description: Reference for Gemini AI generation in MomentumX — model factory, generation helpers, configs, prompt replacement, SSE, embeddings, and clustering. Use when implementing or modifying any AI generation feature.
---

# AI Generation Reference

Read `.claude/rules/ai-generation-patterns.md` and the affected service end to end.
`src/config/ai.ts` selects `GENERATION_MODEL` (default `gemini-3.8-flash`) using `API_KEY`;
embeddings remain `gemini-embedding-001`. Do not initialize a separate model in a service.

Current helpers in `src/utlils/ai.ts` include:

- `generateStreamingContent(systemPrompt, userPrompt, generationConfig)` for the existing
  text-stream adapter; `generateContent` adds multimodal input.
- `collectJson<T>(stream, label)` drains and validates structured JSON output. Do not
  replace it with inline accumulation and `JSON.parse`.
- `generateTextContent` requests a complete nonstreamed provider response for JSON script
  regeneration; `streamScript` serves opt-in script regeneration through `@google/genai`.
  Other adapters still use `@google/generative-ai`; do not assume one SDK covers every path.

Inspect exact signatures before calling helpers. Generation configs are in
`src/constants/firebase.ts` and prompts in `src/constants/prompt.ts`; these source files
are the inventory. Match structured schemas and plain-text prompts to their real output.
Use `fillTemplate` from `src/utlils/prompt-blocks.ts` for untrusted values; direct string
replacement can interpret `$` sequences in user text. Preserve channel-scoped context and
edited-script authority across ideas, scripts, hooks and publishing assets.

Use existing generation guards and billing/delivery seams. Preserve the shared bounded
503-only retry policy; never replay partial streams or failed saving. Follow each
endpoint's SSE contract in `docs/api-communication.md`, not a generic stream recipe.
The initial GET and opt-in POST transports differ. Saving must precede final success.

Clustering queries exclude archived ideas and cap the channel's pool at 200. The utility
uses `k = min(8, ceil(n/20))` and skips clustering when `n <= k`. Keep query and utility
guards together. Read current editorial instructions in `src/constants/prompt.ts` and
behavioral checks in `tests/unit/prompt-continuity.review.test.ts`; use
`docs/product/pipeline-spec.md` for the creator workflow. Live model evaluation requires
explicit authorization.
