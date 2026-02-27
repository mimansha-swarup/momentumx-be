---
title: "Hooks Feature Spec"
description: "How the Hooks step works — hook generation, selection mechanic, and state machine behavior"
date: 2026-02-27
last_updated: 2026-02-27
status: "draft"
tags: ["feature", "hooks", "spec"]
---

# Hooks Feature Spec

## Overview

Hooks is Step 3 of the MomentumX content pipeline. It generates 5 hook variations from an approved script and title. The creator selects one hook, which completes the Hooks step and feeds into Packaging as context.

Hooks generation is currently implemented inside the Packaging module (`POST /v1/packaging/generate-hooks`). Extracting Hooks into its own pipeline step — with a dedicated endpoint, Firestore collection, and state tracking — is Phase 0 work.

---

## Pipeline Position

| Attribute | Value |
|---|---|
| Step | 3 of 4 |
| Requires | Completed script from the Script step |
| Unlocks | Packaging step |
| Completion mechanic | Creator selects one hook → `selectedHookId` stored on video project → Hooks step = `completed` |

---

## What Gets Built During This Step

When Hooks completes (planned — not yet fully built):
1. Gemini generates 5 hook variations from the script and title
2. Hooks batch is saved to the `hooks` Firestore collection
3. The creator selects one hook → `selectedHookId` stored on the video project
4. Packaging step becomes available

Currently, only step 1 is built (inside the Packaging module). Steps 2–4 are Phase 0 work.

---

## AI Generation

| Attribute | Value |
|---|---|
| Model | `gemini-2.0-flash` |
| Prompt | `PACKAGING_HOOKS_PROMPT` in `src/constants/prompt.ts` |
| Generation config | `GENERATION_CONFIG_PACKAGING` (JSON object output) |
| Output | JSON object with `hooks` array — 5 strings |
| Delivery | Standard JSON response (not SSE) |

### Prompt Variables

| Variable | Source |
|---|---|
| `{title}` | Video title passed in request body |
| `{script}` | Script text passed in request body |

### Hook Styles

Each of the 5 hooks uses a distinct style:

| Style | Description |
|---|---|
| Question | Opens with a question that creates curiosity or tension |
| Shock | States a surprising or counterintuitive fact |
| Story | Teases a story or outcome without revealing it |
| Challenge | Frames the video as addressing a challenge the viewer faces |
| Promise | States a concrete outcome the viewer will get |

---

## State Machine

```
not_started → in_progress → completed
                  ↑
            (stale resets here)
```

| State | Meaning |
|---|---|
| `not_started` | Hooks haven't been triggered for this video project |
| `in_progress` | Hooks generated, creator reviewing or iterating |
| `completed` | Creator selected one hook — `selectedHookId` set on video project |

### Stale Behavior

Hooks becomes stale when the script is regenerated. When `stale: true`, the hooks were generated from an older version of the script. The creator must re-generate or explicitly acknowledge before the step counts as done.

If hooks are regenerated while a packaging document exists downstream, Packaging is marked `stale: true`.

---

## Batch and Archive Model (Planned — Phase 0)

Hooks are generated in batches. Each batch produces 5 variations saved as a single Firestore document. When the creator regenerates, the previous batch is archived (`archived: true`) and a new batch is created.

### Planned `hooks` Collection Document Shape

| Field | Type | Description |
|---|---|---|
| `id` | `string` | UUID |
| `videoProjectId` | `string` | Foreign key to the video project |
| `userId` | `string` | Owner |
| `batchId` | `string` | Identifies the generation batch |
| `hooks` | `string[]` | Array of 5 hook strings |
| `archived` | `boolean` | `true` if superseded by a later batch |
| `createdAt` | `Timestamp` | Server-side timestamp |

This collection and shape are not yet built. Defined in `pipeline-spec.md` as the Phase 0 target.

---

## Current Location: Inside Packaging

The generation logic currently lives in `PackagingService.generateHooks()` (`src/service/packaging.service.ts`). It calls Gemini with `PACKAGING_HOOKS_PROMPT` and `GENERATION_CONFIG_PACKAGING`, parses the JSON response, and returns the result directly. No Firestore write occurs.

The route is `POST /v1/packaging/generate-hooks` (packaging router).

This is a known architectural gap. Hooks belongs between Script and Packaging in the pipeline. Extracting it to its own step with a `POST /v1/hooks/generate` endpoint and `hooks` Firestore collection is a Phase 0 task.

---

## Build Status

| Component | Status |
|---|---|
| Hook generation via Gemini (`PACKAGING_HOOKS_PROMPT`) | ✅ Built |
| `POST /v1/packaging/generate-hooks` (inside Packaging module) | ✅ Built (temporary location) |
| Dedicated `POST /v1/hooks/generate` endpoint | ❌ Not built |
| `hooks` Firestore collection | ❌ Not built |
| Hook batch save to Firestore | ❌ Not built |
| Hook archive on regenerate | ❌ Not built |
| Hook selection endpoint (`POST /v1/hooks/:hookId/select`) | ❌ Not built |
| `selectedHookId` on video project | ❌ Not built |
| Hooks step state tracking on video project | ❌ Not built |
| Stale flag: script change → hooks `stale: true` | ❌ Not built |
| Stale cascade: hooks regenerated → packaging `stale: true` | ❌ Not built |

---

## Related Documentation

- [Hooks API Reference](./api.md)
- [Packaging Feature Spec](../packaging/spec.md)
- [Pipeline Spec](../../product/pipeline-spec.md)
- [Product Roadmap](../../product/roadmap.md)
