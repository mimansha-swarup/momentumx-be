# Onboarding and profile API

Base: `/v1/user`. All endpoints require Firebase bearer authentication and verified channel membership. Writes require `X-Account-Id` and editor/owner role; profile reads allow viewers and retain the documented headerless fallback. See [shared API conventions](../../api-communication.md) for envelopes, access errors and credits.

| Method/path | Request | Success `data` |
|---|---|---|
| `POST /onboarding/prefill` | `{ channelUrl }` | `{ suggestions: { niche, targetAudience, brandName }, channel: { channelDescription, topTitles } }` |
| `PATCH /onboarding` | Setup fields below | `{ payload: publicProfile }` |
| `POST /refresh-context` | No body | `publicProfile` |
| `GET /profile` | No body | `publicProfile` |
| `PATCH /profile` | Partial setup fields | `{ payload: publicProfile }` |

Prefill returns suggestions without saving them; unresolved channel lookups may yield empty suggestions. Onboarding saves immediately; refresh separately enriches the saved inputs. Profile edits can enrich fields included in that request. Failure of a later refresh does not undo a successful onboarding save.

## Inputs

Onboarding requires either `userName` (a supported YouTube channel URL) or both `niche` and `targetAudience`. Profile updates have no cross-field minimum. `userName` is the channel-URL field; prefill calls it `channelUrl`.

Other accepted fields: `brandName`, `website`, `purpose`, `description`, `competitors` (channel URL array), and `format` (`talking_head` or `faceless`). Unknown keys are stripped.

Strings are trimmed and capped: niche/brand 200, audience 500, purpose 1,000, description 5,000 and URLs 2,000 characters. At most 20 competitors are accepted. YouTube URLs must use supported channel forms; websites accept HTTP(S) or an empty string. Invalid input returns 400.

## Profile output

The profile combines login identity with the selected channel’s public setup fields and `completeness: { score, missing }`. Completeness is a 0–100 setup indicator, not an assessment of output quality. Competitors expose URLs and available IDs.

Large enrichment pools, scraped website text and resolved channel descriptions are omitted from profile responses. Prefill deliberately includes channel description/top titles for the first-idea context override. Deliberately chosen channel names are preserved during enrichment.

[Creator flow](./spec.md) · [Channel guide](../../multi-account/README.md)
