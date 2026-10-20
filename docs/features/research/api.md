# Research and ideas API

All calls require `Authorization: Bearer <Firebase ID token>` and selected-channel membership. Writes require `X-Account-Id` and editor/owner role. Saved idea reads and exports allow viewers; `/v1/research/*` requires editor/owner even though those calls use GET and public data. Reads retain the documented headerless channel fallback. Access follows channel membership, not authorship. See [shared API conventions](../../api-communication.md) for envelopes, channel selection, errors and credits.

JSON successes use `{ success: true, message, data }`. Common failures include 400 invalid input, 401 invalid/missing authentication, 403 insufficient access, 404 missing/unavailable resource, 409 generation conflict, 402 insufficient credits when enforcement applies, and 503 provider unavailability. See shared conventions for machine-readable codes and retry behavior.

## Ideas

Base: `/v1/ideas`.

| Method/path | Request | Success `data` |
|---|---|---|
| `POST /generate` | Optional `{ context: { niche?, targetAudience?, brandName?, topTitles? } }` | Idea array |
| `GET /` | Pagination/search query below | `{ lists: Idea[], meta: { hasNextPage, nextCursor } }` |
| `PATCH /edit/:ideaId` | `{ title }` | `{ title, id }` |
| `POST /regenerate-all` | No body | Replacement Idea array |
| `POST /:ideaId/regenerate` | No body | Replacement Idea |
| `GET /export` | No body | `{ text, count }` |

An Idea exposes `id`, working `title`, `concept`, `ideaType` (`long` or `short` for new output), `evidence`, `accountId`, authorship, available timestamps and selection/archive state. Older saved ideas may lack newer fields. Evidence may be empty. Embeddings and batch internals are not returned.

Generation targets ten ideas but can return fewer if some cannot be prepared for storage. Optional context overrides stored context for this request without completing onboarding. Context strings are trimmed; limits are niche/brand 200 characters, audience 500, and 20 top titles of 300 characters each. Unknown fields are stripped. Title edits accept only a non-empty title up to 300 characters.

Generation and both regeneration endpoints default to JSON. With `Accept: text/event-stream`, they emit named `progress`, `result` and `generation_error` events. A result contains the normal success envelope; heartbeat comments indicate connection liveness only. Handle streamed errors even when HTTP status is 200. See [streaming conventions](../../api-communication.md).

Regenerate All saves a fresh batch and archives prior active ideas. Regenerate One preserves its idea ID and replaces that slot. Both can make dependent projects need review. Archived ideas are excluded from the active list and repetition comparison. Select an idea by [creating a project](../video-project/api.md); generation alone does not create one.

## Listing

| Query | Meaning |
|---|---|
| `limit` | Default 9, maximum 50; invalid/non-positive values use the default |
| `searchText` | Title-prefix search |
| `isScriptGenerated` | `true` or `false`; omitted means no filter |
| `createdAt`, `title`, `docId` | Cursor fields: echo the returned `nextCursor` for the active sort |

Normal order is newest first; search orders by title. Use `hasNextPage` to decide whether to request another page; `nextCursor` is null for an empty result. Idea timestamps, when available, are ISO strings.

## Public research

Base: `/v1/research`. Read-only calls use public YouTube data and may serve cached results.

| Method/path | Request | Success `data` |
|---|---|---|
| `GET /trending` | No body; selected channel must have a niche | `[{ title, channelTitle, videoId }]` |
| `GET /competitors` | No body; uses configured resolved competitors | `[{ channelTitle, titles: string[] }]` |
| `GET /keywords?query=...` | Non-empty search text | `[{ title, channelTitle, videoId }]` |

Trending returns 400 when the niche is missing. Competitors without a resolved channel ID are skipped; unavailable names use “Unknown channel”, and unavailable video lists can be empty. No configured competitors returns an empty array. Keywords returns 400 for an empty query. These signals are not private analytics or guaranteed performance predictions.

[Creator flow](./spec.md) · [Project API](../video-project/api.md)
