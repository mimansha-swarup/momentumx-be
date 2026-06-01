---
title: "Script Generation — Feature Spec"
description: "How script generation works in the MomentumX pipeline, what's built, and what's not."
date: 2026-02-27
last_updated: 2026-03-11
status: "implemented"
tags: ["feature", "script", "spec"]
---

# Script Generation

## Overview

Script is step 2 of 4 in the MomentumX content pipeline. Generation is always scoped to a video project: it loads the project, derives the source topic from `project.topicId`, and generates a full ~10-minute YouTube video script via a streaming AI response.

The script is streamed to the client over SSE as it generates, then saved to Firestore when the stream completes. The topic document is updated to mark `isScriptGenerated: true` after saving.

Pipeline position: Research → **Script** → Hooks → Packaging

---

## Pipeline Position

| Attribute | Value |
|---|---|
| Step | 2 of 4 |
| Requires | A video project (the topic is derived from `project.topicId`) |
| Unlocks | Hooks step |
| Completion mechanic | Automatic — the Script step is completed server-side as soon as the generated script is saved |

---

## What's Built

### SSE Script Generation

`GET /v1/scripts/stream/:projectId`

Streams a full video script for the given **video project**. The `:projectId` URL parameter is the video project ID — the script is generated for the topic referenced by `project.topicId`. The script document is stored in Firestore under its **own** `randomUUID` id (reused across regenerations via `project.scriptId`), not the topic's id.

**Auth exception:** This endpoint does not use the `Authorization: Bearer` header. It accepts a `?token=` query parameter instead, verified by `sseAuthMiddleware`. The browser `EventSource` API cannot send custom headers, so the token is passed in the URL.

**Generation flow:**
1. `sseAuthMiddleware` verifies the `?token=` query param using Firebase Admin SDK and sets `req.userId`
2. The project is loaded and ownership-checked (throws 404 if missing, 403 if not owner)
3. User profile and the topic (from `project.topicId`) are fetched in parallel — 404 if the topic is missing
4. The script id is `project.scriptId ?? randomUUID()` — an existing script id is reused on regenerate so the old doc is not orphaned
5. The script prompt is built by injecting the topic title and user context into `SCRIPT_USER_PROMPT`
6. Gemini (`gemini-3.5-flash`) streams the response using `GENERATION_CONFIG_SCRIPTS`
7. Each chunk is forwarded to the client as an SSE event
8. After the stream ends, the full accumulated text is formatted via `formatGeneratedScript` (storing `topicId` and `videoProjectId` FKs) and saved to Firestore
9. The topic document is updated: `isScriptGenerated: true`, and the script is linked to the project via `linkResource` + `completeStep`

**SSE chunk format** (chunk text is JSON-stringified via `JSON.stringify`):
```
data: "chunk text here"\n\n
```

Stream end signal:
```
data: [DONE]\n\n
```

**Prompt:** `SCRIPT_USER_PROMPT` in `src/constants/prompt.ts`. Injects `{userName}`, `{targetAudience}`, `{competitors}`, `{niche}`, `{websiteContent}`, `{title}`. Uses `GENERATION_CONFIG_SCRIPTS` (plain text output config — NOT JSON).

### List Scripts

`GET /v1/scripts`

Returns all script documents owned by the authenticated user, ordered by `createdAt` descending.

### Get Single Script

`GET /v1/scripts/:scriptId`

Returns a single script document by ID. Ownership enforced — `createdBy` must match the requesting user.

### Edit Script

`PATCH /v1/scripts/edit/:scriptId`

Accepts fields in the request body and merges them onto the script document. Manual edit only — not AI-assisted. Ownership enforced.

---

## Script Document Shape

Stored in the `scripts` Firestore collection. The document has its own `randomUUID` id and stores `topicId` + `videoProjectId` foreign keys.

| Field | Type | Description |
|---|---|---|
| `id` | `string` | Own `randomUUID` — NOT the topicId |
| `title` | `string` | Title of the topic this script was generated for |
| `createdBy` | `string` | `userId` of the owner |
| `createdAt` | `Timestamp` | Server-side Firestore timestamp |
| `script` | `string` | Full script text |
| `topicId` | `string` | FK → source topic |
| `videoProjectId` | `string` | FK → owning video project |

---

## Topic Document Side Effect

After a script is saved, the source topic document is updated:

```
isScriptGenerated: true
```

This is one of two cross-document side effects of script generation. Because generation is always scoped to a video project, the Script step also transitions via `startStep` (before streaming) and `linkResource` + `completeStep` (after saving). `isScriptGenerated` remains as a lightweight proxy on the topic for clients that read it directly.

---

## Architectural Decisions

### Script Identity Decoupled From Topic

The script document has its own `randomUUID` id and links back to its source topic and project via `topicId` + `videoProjectId` foreign-key fields. The script id is no longer the topic id. This lets multiple projects share a single topic while each owns an independent script, which a deterministic `id == topicId` scheme could not support. The id is minted once per project and reused on regenerate (via `project.scriptId`) so regeneration overwrites the same document rather than orphaning it.

Tradeoff: when a script is regenerated, the `script` field on the existing document is overwritten in place. No version history is kept.

### SSE Auth via Query Param

The browser `EventSource` API cannot send custom request headers, which makes Bearer token auth impossible. The token is passed as `?token=` and verified manually using Firebase Admin SDK. This pattern is used only for SSE endpoints. All other endpoints use standard `authMiddleware`.

### Plain Text Generation Config

The script prompt uses `GENERATION_CONFIG_SCRIPTS` (`responseMimeType: "text/plain"`). Using a JSON config would cause Gemini to wrap the script in JSON structure, breaking the raw text SSE stream. Prompt and config must stay paired.

---

## Security

| Endpoint | Auth method | Ownership check |
|---|---|---|
| `GET /scripts/stream/:projectId` | `?token=` query param (`sseAuthMiddleware`) | Yes — project is loaded and ownership-checked before the stream starts (403 if not owner, 404 if no project/topic) |
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
