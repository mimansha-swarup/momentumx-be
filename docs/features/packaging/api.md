# Title and packaging API

All calls require `Authorization: Bearer <Firebase ID token>` and selected-channel membership. Writes require `X-Account-Id` and editor/owner role; reads and exports allow viewers and retain the documented headerless read fallback. Access follows channel membership, not authorship. See [shared API conventions](../../api-communication.md) for envelopes, channel selection, errors and credits.

JSON successes use `{ success: true, message, data }`. Common failures include 400 invalid input, 401 invalid/missing authentication, 403 insufficient access, 404 missing/unavailable resource, 409 generation conflict, 402 insufficient credits when enforcement applies, and 503 provider unavailability. See shared conventions for machine-readable codes and retry behavior.

Base: `/v1/packaging`. These generation endpoints return JSON.

## Generate

All four calls accept optional `videoProjectId` and `script`. A non-empty supplied script takes precedence over saved project text. With a project, generated output is saved and the response adds `packagingId`. Without one, generation returns a preview; use save to retain it.

| Method/path | Additional input | Success `data` |
|---|---|---|
| `POST /generate-title` | Script must be supplied or available from the project | `{ titles: [{ title, characterCount, score, reason }], packagingId? }` |
| `POST /generate-description` | Required `title` | `{ description, packagingId? }` |
| `POST /generate-thumbnail` | Required `title` | `{ descriptions: string[], packagingId? }` |
| `POST /generate-shorts` | Required integer `duration` (seconds, 1–600); script supplied or available from project | `{ segments, totalDuration, packagingId? }` |

Title targets three alternatives; editorial `score` (1–10) and `reason` express fit to the supplied material, not predicted performance. Legacy saved titles may omit these fields. Thumbnail generation targets three **text concepts**, not image URLs. A Shorts segment can contain `startTime`, `endTime`, `type` and `content`; `totalDuration` is human-readable text.

Scripts are capped at 100,000 characters and titles at 300. Unknown request keys are stripped. Selected hooks are obtained from the linked project; clients do not send them.

## Save edits

`POST /save` accepts only:

| Field | Accepted value |
|---|---|
| `videoProjectId` | Optional existing project ID; omit to create a project for this work |
| `titles` | Title-object array or `{ titles: [...] }` |
| `description` | String or `{ description: "..." }` |
| `thumbnail` | String array or `{ descriptions: [...] }` |
| `shorts` | `{ segments: [...], totalDuration? }` |
| `selectedTitleIndex`, `selectedThumbnailIndex` | Non-negative integer within the relevant array, or null to clear |

Send the fields being edited. Generated output linked to a project is already saved; do not resend an old snapshot. Unknown keys, including client-supplied status/ownership fields, are stripped. Malformed content or selection returns 400. Empty content values are ignored; this is not a clear-content operation.

The response is the saved packaging record in `data`, including its `id` and `videoProjectId`. Saving edits preserves existing review warnings. Editing a selected title also updates the project name, but only title selection completes the Title step.

## Read, select, regenerate and export

| Method/path | Request | Success `data` |
|---|---|---|
| `GET /list` | No body | Packaging record array |
| `GET /:packagingId` | No body | Packaging record |
| `POST /:packagingId/select-title` | `{ index }` | `{ id, selectedTitleIndex, title }` |
| `POST /:packagingId/regenerate/:item` | `{ script?, title?, duration? }` | `{ id, item, data: replacementValue }` |
| `GET /:packagingId/export` | No body | `{ text }` |

A record includes content as `titles: object[]`, `description: string`, `thumbnail: string[]`, and `shorts: { segments, totalDuration? } | null`, plus selections, project/channel/authorship and status metadata. Treat its ID as opaque.

Select a title using a non-negative integer within the returned array. The selection updates the linked project name and completes Title. Regeneration may clear selections because it replaces the alternatives.

Regeneration `item` is `title`, `description`, `thumbnail` or `shorts`. It uses the project already attached to the record; no replacement `videoProjectId` is accepted. Script may be omitted when stored on that project. Title/Shorts require script content; description/thumbnail require a title; Shorts regeneration defaults to 60 seconds when duration is omitted. The replacement value is the canonical bare value (title array, description string, thumbnail string array or Shorts object), not the generation wrapper.

`itemStatuses` uses `not_started | completed | stale`. Packaging review metadata includes `isStale`, `staleReason` and `staleSince`. Refreshing the last outdated packaging-owned asset can clear its warning; Title is tracked separately. Saving edits alone does not acknowledge stale work.

[Creator flow](./spec.md) · [Pipeline model](../../product/pipeline-spec.md)
