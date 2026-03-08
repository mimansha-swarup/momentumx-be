---
title: "Script Generation — Feature Spec"
description: "How script generation works in the MomentumX pipeline, what's built, and what's not."
date: 2026-02-27
last_updated: 2026-03-08
status: "implemented"
tags: ["feature", "script", "spec"]
---

# Script Generation

## Overview

Script is step 2 of 4 in the MomentumX content pipeline. It takes a selected topic from the Research step and generates a full ~10-minute YouTube video script via a streaming AI response.

The script is streamed to the client over SSE as it generates, then saved to Firestore when the stream completes. The topic document is updated to mark `isScriptGenerated: true` after saving.

Pipeline position: Research → **Script** → Hooks → Packaging

---

## Pipeline Position

| Attribute | Value |
|---|---|
| Step | 2 of 4 |
| Requires | Selected topic from Research step |
| Unlocks | Hooks step |
| Completion mechanic | Creator explicitly marks script done ("Use This Script") |

---

## What's Built

### SSE Script Generation

`GET /v1/content/stream/scripts/:scriptId`

Streams a full video script for the given topic. The `:scriptId` URL parameter is actually the **topicId** — the script document is stored in Firestore with the same ID as its source topic.

**Auth exception:** This endpoint does not use the `Authorization: Bearer` header. It accepts a `?token=` query parameter instead. The browser `EventSource` API cannot send custom headers, so the token is passed in the URL and verified manually in the controller before the stream starts.

**Generation flow:**
1. Controller verifies the `?token=` query param manually using Firebase Admin SDK
2. User profile and topic document are fetched in parallel
3. The script prompt is built by injecting the selected title and user context into `SCRIPT_USER_PROMPT`
4. Gemini (`gemini-2.0-flash`) streams the response using `GENERATION_CONFIG_SCRIPTS`
5. Each chunk is forwarded to the client as an SSE event
6. After the stream ends, the full accumulated text is formatted via `formatGeneratedScript` and saved to Firestore
7. The topic document is updated: `isScriptGenerated: true`

**SSE chunk format** (chunk text is JSON-stringified via `JSON.stringify`):
```
data: "chunk text here"\n\n
```

Stream end signal:
```
event: done\n
data: [done]\n\n
```

**Prompt:** `SCRIPT_USER_PROMPT` in `src/constants/prompt.ts`. Injects `{userName}`, `{targetAudience}`, `{competitors}`, `{niche}`, `{websiteContent}`, `{title}`. Uses `GENERATION_CONFIG_SCRIPTS` (plain text output config — NOT JSON).

### List Scripts

`GET /v1/content/scripts`

Returns all script documents owned by the authenticated user, ordered by `createdAt` descending.

### Get Single Script

`GET /v1/content/script/:scriptId`

Returns a single script document by ID. Ownership enforced — `createdBy` must match the requesting user.

### Edit Script

`PATCH /v1/content/script/edit/:scriptId`

Accepts fields in the request body and merges them onto the script document. Manual edit only — not AI-assisted. Ownership enforced.

---

## Script Document Shape

Stored in the `scripts` Firestore collection. Document ID equals the `topicId` of the source topic.

| Field | Type | Description |
|---|---|---|
| `id` | `string` | Same as the source `topicId` |
| `title` | `string` | Title of the topic this script was generated for |
| `createdBy` | `string` | `userId` of the owner |
| `createdAt` | `Timestamp` | Server-side Firestore timestamp |
| `script` | `string` | Full script text |

---

## Topic Document Side Effect

After a script is saved, the source topic document is updated:

```
isScriptGenerated: true
```

This is one of two cross-document side effects of script generation. Additionally, if the topic is linked to a video project, the Script step transitions via `startStep` (before streaming) and `linkResource` + `completeStep` (after saving) — both fire-and-forget. `isScriptGenerated` remains as a lightweight proxy for clients that do not use the video project model.

---

## Architectural Decisions

### Script ID Equals Topic ID

The script document uses the `topicId` as its Firestore document ID. This creates a deterministic 1:1 relationship between a topic and its script without a foreign key field. Retrieving a script for a known topic is a direct key fetch, not a query.

Tradeoff: when a script is regenerated, the `script` field on the existing document is overwritten in place. No version history is kept.

### SSE Auth via Query Param

The browser `EventSource` API cannot send custom request headers, which makes Bearer token auth impossible. The token is passed as `?token=` and verified manually using Firebase Admin SDK. This pattern is used only for SSE endpoints. All other endpoints use standard `authMiddleware`.

### Plain Text Generation Config

The script prompt uses `GENERATION_CONFIG_SCRIPTS` (`responseMimeType: "text/plain"`). Using a JSON config would cause Gemini to wrap the script in JSON structure, breaking the raw text SSE stream. Prompt and config must stay paired.

---

## Security

| Endpoint | Auth method | Ownership check |
|---|---|---|
| `GET /stream/scripts/:scriptId` | `?token=` query param | None — no check that topic belongs to requesting user |
| `GET /scripts` | Bearer token via `authMiddleware` | Yes — filters by `createdBy == userId` |
| `GET /script/:scriptId` | Bearer token via `authMiddleware` | Yes — throws 403 if `createdBy !== userId` |
| `PATCH /script/edit/:scriptId` | Bearer token via `authMiddleware` | Yes — throws 403 if `createdBy !== userId` |
| `POST /scripts/:scriptId/regenerate` | Bearer token via `authMiddleware` | Yes — throws 403 if `createdBy !== userId` |
| `PATCH /scripts/:scriptId/feedback` | Bearer token via `authMiddleware` | Yes — throws 403 if `createdBy !== userId` |
| `GET /scripts/:scriptId/export` | Bearer token via `authMiddleware` | Yes — throws 403 if `createdBy !== userId` |

---

## Build Status

| Feature | Status |
|---|---|
| SSE script generation | ✅ Built |
| List scripts | ✅ Built |
| Get single script (with ownership check) | ✅ Built |
| Edit script (with ownership check) | ✅ Built |
| Regenerate script (`POST /scripts/:scriptId/regenerate`) | ✅ Built |
| Script feedback (`PATCH /scripts/:scriptId/feedback`) | ✅ Built |
| Export script (`GET /scripts/:scriptId/export`) | ✅ Built |
| Stale cascade on regen → Hooks + Packaging stale | ✅ Built (fire-and-forget) |
| Script step state tracking on video project | ✅ Built (startStep / completeStep wired) |
| Server-side `createdAt` timestamp | ✅ Built (`serverTimestamp()`) |
| AI-assisted script editing | ❌ Not built — only manual text overwrite |

---

## Related Documentation

- [Script API Reference](./api.md)
- [Research Feature Spec](../research/spec.md)
- [Pipeline Spec](../../product/pipeline-spec.md)
- [Product Roadmap](../../product/roadmap.md)
