# Script API

All calls require `Authorization: Bearer <Firebase ID token>` and selected-channel membership. Writes require `X-Account-Id` and editor/owner role; saved-content reads and exports allow viewers and retain the documented headerless read fallback. Initial GET generation is an exception: it derives the channel from the project and requires editor/owner permission, as detailed below. Access follows channel membership, not authorship. See [shared API conventions](../../api-communication.md) for envelopes, channel selection, errors and credits.

JSON successes use `{ success: true, message, data }`. Common failures include 400 invalid input, 401 invalid/missing authentication, 403 insufficient access, 404 missing/unavailable resource, 409 generation conflict, 402 insufficient credits when enforcement applies, and 503 provider unavailability. See shared conventions for machine-readable codes and retry behavior.

Base: `/v1/scripts`.

| Method/path | Request | Success |
|---|---|---|
| `GET /stream/:projectId` | Project ID, no body | Script text over SSE |
| `GET /` | No body | Script array in `data`, newest first |
| `GET /:scriptId` | Script ID | Script in `data` |
| `PATCH /edit/:scriptId` | `{ script?, title? }`; at least one | `data: { script?, title?, scriptId }` |
| `POST /:scriptId/regenerate` | No body | `data: { id, title, script }` |
| `GET /:scriptId/export` | No body | `data: { title, text }` |

A saved script includes `id`, `title`, `script`, `accountId`, `createdBy`, timestamps and its `ideaId`/`videoProjectId` links. Treat script, project and idea IDs as opaque; use the returned links rather than assuming they differ or match. Manual edits allow only script text (1–100,000 characters) and title (trimmed, 1–300 characters); unknown fields are stripped.

Initial generation returns saved script content when it already exists. Use the explicit regeneration endpoint to replace it. Regeneration reuses the script ID and can make Hooks, Title and Packaging need review. Editing script text also invalidates downstream work; title-only edits do not.

## Initial script stream

`GET /stream/:projectId` prefers a bearer header and accepts `?token=<Firebase ID token>` for compatibility with browser EventSource. The project determines the channel; current membership and editor/owner permission are required. Do not send an arbitrary account query parameter.

A successful connection uses `Content-Type: text/event-stream`. Text arrives as JSON strings in ordinary data events:

```text
data: "script text chunk"

data: [DONE]
```

Failure can arrive as a named event. A failure uses `event: generation_error` with JSON containing `message` and optional `code`/`detail`, followed by `[DONE]`. Errors before streaming begins use ordinary JSON and their HTTP status. Do not interpret `[DONE]` or connection closure alone as a saved-script success.

## Regeneration transport

Regeneration normally returns JSON after saving. With `Accept: text/event-stream`, it emits named `progress`, `chunk` (`{ text }`), `result` (success envelope) or `generation_error` events. This opt-in POST stream is a different format from the initial GET stream. Heartbeats are comments, not generation progress.

An interrupted provider draft is not accepted as a completed replacement. Clients should retain existing saved work while displaying a failed attempt. See [shared streaming/error conventions](../../api-communication.md).

[Creator flow](./spec.md) · [Pipeline flow](../../product/pipeline-spec.md)
