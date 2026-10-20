# Video project API

All calls require `Authorization: Bearer <Firebase ID token>` and selected-channel membership. Writes require `X-Account-Id` and editor/owner role; reads and exports allow viewers and retain the documented headerless read fallback. Access follows channel membership, not authorship. See [shared API conventions](../../api-communication.md) for envelopes, channel selection, errors and credits.

JSON successes use `{ success: true, message, data }`. Common failures include 400 invalid input, 401 invalid/missing authentication, 403 insufficient access, 404 missing/unavailable resource, 409 generation conflict, 402 insufficient credits when enforcement applies, and 503 provider unavailability. See shared conventions for machine-readable codes and retry behavior.

Base: `/v1/video-projects`.

| Method/path | Request | Success `data` |
|---|---|---|
| `POST /` | Exactly one of `{ ideaId }` or `{ title }` | Project, HTTP 201 |
| `GET /` | Optional `status`, `limit`, `cursor` | `{ projects, hasMore, nextCursor }` |
| `GET /:projectId` | No body | Project detail |
| `PATCH /:projectId` | `{ title }` | `{ title }` |
| `DELETE /:projectId` | No body | `{ id, isDeleted: true }` |
| `PATCH /:projectId/step/:stepName/complete` | No body | `{ id, currentStep, pipeline, overallStatus }` |
| `PATCH /:projectId/link/:resourceType` | `{ resourceId }` | Updated resource link |

Project creation completes Research. A supplied title must be non-empty and at most 300 characters. The idea and all linked resources must belong to the selected channel. Each project can have its own script even when projects share an idea.

## List and detail

List query `status` accepts `in_progress`, `completed` or `stale`. `limit` defaults to 20, is capped at 50, and uses the default for invalid/non-positive values. Echo `nextCursor` as `cursor` for another page.

List entries include `id`, `title`, `currentStep`, `overallStatus`, timestamps and `thumbnailHint` (selected text thumbnail concept or null). The full pipeline is available on detail, not list.

Detail includes channel/authorship, idea/script/hooks/packaging links, selected hook index, title, thumbnail hint, pipeline and deletion/timestamp fields. Pipeline keys are `research`, `script`, `hooks`, `title`, `packaging`. Each step has `status`, start/completion timestamps and an optional stale reason.

Step status is `not_started | in_progress | completed | stale`; overall status is `in_progress | completed | stale`. Detail adds `recommendedNextStep`: the first unfinished/outdated step or null. It is not necessarily the stored `currentStep`.

## Editing, completion and links

Rename accepts only a non-empty title of at most 300 characters. Soft deletion is idempotent; it hides the project without deleting the associated content.

Generation owns the transition into progress: there is no public `/step/:stepName/start` route.

Manual completion supports `script`, `hooks`, `title` and `packaging`. A never-started step returns 400; completing an already-completed step is idempotent. It also supports “Keep as-is” for outdated content and recomputes the overall status. Completing stale Packaging attempts to clear its item warnings as well.

Linking accepts `resourceType` of `script`, `hooks` or `packaging`. A valid same-channel saved resource is required. The response includes the changed resource field (`scriptId`, `hooksId` or `packagingId`) and may include `thumbnailHint`. Linking a package does not by itself mean all its assets are complete.

Unavailable/deleted projects return 404; invalid step/resource values or missing input return 400. See shared conventions for cross-channel visibility and permission errors.

[Creator flow](./spec.md) · [Pipeline model](../../product/pipeline-spec.md)
