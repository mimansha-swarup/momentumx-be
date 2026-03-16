---
title: "Hooks Feature Spec"
description: "How the Hooks step works — hook generation, selection mechanic, and state machine behavior"
date: 2026-02-27
last_updated: 2026-03-17
status: "implemented"
tags: ["feature", "hooks", "spec"]
---

# Hooks Feature Spec

## Overview

Hooks is Step 3 of the MomentumX content pipeline. It generates 5 hook variations from an approved script and title. The creator selects one hook, which completes the Hooks step and feeds into Packaging as context.

Hooks has its own dedicated endpoints, Firestore collection, and state tracking. The standalone `POST /v1/hooks/generate` and `POST /v1/hooks/:hooksId/select` endpoints are live. The legacy `POST /v1/packaging/generate-hooks` endpoint still exists for stateless generation but is no longer the canonical path.

---

## Pipeline Position

| Attribute | Value |
|---|---|
| Step | 3 of 4 |
| Requires | Completed script from the Script step |
| Unlocks | Packaging step |
| Completion mechanic | Creator selects one hook → `selectedHookIndex` stored on video project → Hooks step = `completed` |

---

## What Gets Built During This Step

When Hooks completes:
1. Gemini generates 5 hook variations from the script
2. Hooks batch is saved to the `hooks` Firestore collection
3. Resource is linked to the video project (`linkResource` fire-and-forget)
4. The creator selects one hook → `selectedHookIndex` stored on the video project → `completeStep` fires
5. Packaging step becomes available

---

## AI Generation

| Attribute | Value |
|---|---|
| Model | `gemini-2.0-flash` |
| Prompt | `GENERATE_HOOKS_PROMPT` in `src/constants/prompt.ts` |
| Generation config | `GENERATION_CONFIG_PACKAGING` (JSON object output) |
| Output | JSON object with `hooks` array — 5 strings |
| Delivery | Standard JSON response (not SSE) |

### Prompt Variables

| Variable | Source |
|---|---|
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
| `completed` | Creator selected one hook — `selectedHookIndex` set on video project |

### Stale Behavior

Hooks becomes stale when the script is regenerated. When `stale: true`, the hooks were generated from an older version of the script. The creator must re-generate or explicitly acknowledge before the step counts as done.

If hooks are regenerated while a packaging document exists downstream, Packaging is marked `stale: true`.

---

## Batch Model

Hooks are generated in batches. Each batch produces 5 variations saved as a single Firestore document. When the creator regenerates, the hooks and hookFeedback are overwritten in place on the same document (no archive).

### `hooks` Collection Document Shape

| Field | Type | Description |
|---|---|---|
| `id` | `string` | Firestore auto-generated ID |
| `videoProjectId` | `string` | Foreign key to the video project |
| `createdBy` | `string` | `userId` of the owner |
| `hooks` | `string[]` | Array of 5 hook strings |
| `hookFeedback` | `Record<string, "like" \| "dislike" \| null>` | Per-hook feedback keyed by index |
| `createdAt` | `Timestamp` | Server-side timestamp |

---

## Build Status

| Component | Status |
|---|---|
| Hook generation via Gemini | ✅ Built |
| `POST /v1/hooks/generate` — standalone endpoint | ✅ Built |
| `hooks` Firestore collection | ✅ Built |
| Hook batch save to Firestore | ✅ Built |
| Hook selection endpoint (`POST /v1/hooks/:hooksId/select`) | ✅ Built |
| `selectedHookIndex` on video project | ✅ Built |
| Hooks step state tracking on video project | ✅ Built |
| Regenerate hooks (`POST /v1/hooks/:hooksId/regenerate`) | ✅ Built |
| Per-hook feedback (`PATCH /v1/hooks/:hooksId/feedback`) | ✅ Built |
| Export hooks (`GET /v1/hooks/:hooksId/export`) | ✅ Built |
| Stale flag: script change → hooks `stale: true` | ✅ Built |
| Stale cascade: hooks regenerated → packaging `stale: true` | ✅ Built |

---

## Related Documentation

- [Hooks API Reference](./api.md)
- [Packaging Feature Spec](../packaging/spec.md)
- [Pipeline Spec](../../product/pipeline-spec.md)
- [Product Roadmap](../../product/roadmap.md)
