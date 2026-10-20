# Hooks API

All calls require `Authorization: Bearer <Firebase ID token>` and selected-channel membership. Writes require `X-Account-Id` and editor/owner role; reads and exports allow viewers and retain the documented headerless read fallback. Access follows channel membership, not authorship. See [shared API conventions](../../api-communication.md) for envelopes, channel selection, errors and credits.

JSON successes use `{ success: true, message, data }`. Common failures include 400 invalid input, 401 invalid/missing authentication, 403 insufficient access, 404 missing/unavailable resource, 409 generation conflict, 402 insufficient credits when enforcement applies, and 503 provider unavailability. See shared conventions for machine-readable codes and retry behavior.

Base: `/v1/hooks`.

| Method/path | Request | Success `data` |
|---|---|---|
| `POST /generate` | `{ videoProjectId, script? }` | Saved hooks batch |
| `GET /:hooksId` | No body | Saved hooks batch |
| `POST /:hooksId/select` | `{ hookIndex }` | `{ id: projectId, hooksId, selectedHookIndex }` |
| `POST /:hooksId/regenerate` | `{ script? }` or empty body | `{ id: hooksId, hooks }` |
| `GET /:hooksId/export` | No body | `{ text, count }` |

A batch includes `id`, `videoProjectId`, `accountId`, `createdBy`, `hooks: string[]` and timestamps. Generation targets five hooks; clients should render the returned array and select within its actual bounds.

A project with a completed Script step is required for new generation. Omit `script` to use its saved text; a supplied non-empty script overrides it for the request. Supplied text is capped at 100,000 characters. Generation returns the existing linked batch when present; use regenerate for new alternatives.

`hookIndex` is a non-negative integer and must be within the saved hooks array. Selection completes Hooks. The project is inferred from the saved batch for select/regenerate: do not send `videoProjectId` to redirect these operations.

Regeneration replaces the batch and clears the project selection. Changed hooks or a changed selection can make downstream Title and Packaging need review. Read and export remain available without generating again.

These endpoints use ordinary JSON, not the optional progress-stream protocol used by ideas and script regeneration. A missing script or invalid selection returns 400; unmet generation prerequisites or an in-flight run can return 409. Provider output failures return a retryable error rather than a usable batch.

[Creator flow](./spec.md) · [Title and packaging API](../packaging/api.md)
