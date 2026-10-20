# API communication

The creator chooses a channel, asks for generation, watches progress, and receives saved
content. The API keeps that flow consistent across ordinary JSON requests and streaming
connections. Channel authorization and credit rules apply to both.

## Authentication, channels and responses

Protected requests use `Authorization: Bearer <Firebase ID token>`. Channel writes also
require `X-Account-Id`; membership and role are checked on the server. Compatible
headerless reads resolve a live membership. Discovery, bootstrap and invitation flows have
separate context rules. Initial script streaming derives its channel from the project and
requires editor permission; research GET endpoints also require editor because they consume
shared quota. Ordinary saved-content reads and exports allow viewers.

JSON successes use `{ success: true, data, message?, meta?, warning? }`; errors use
`{ success: false, message, code?, detail? }`. Statuses distinguish invalid input (400),
missing/invalid authentication (401), insufficient configured credits (402), denied access
(403), missing resources (404), conflicting generation/prerequisites (409), deleted channels
(410), unexpected failure (500), and provider/delivery unavailability (503). Streamed errors
can arrive after a 200 response; use the stream's error event rather than HTTP status alone.

For access errors, `account_forbidden` means no channel membership; `wrong_account` means
the resource is in another channel the caller can access, with safe switch details;
`role_forbidden` means membership exists but the action is unavailable to that role. A role
refusal must not sign out or eject a valid member. Internal server details are masked.

Generation uses the selected channel's nominated payer. Allowance enforcement is optional:
missing/disabled configuration allows generation, but an explicit numeric zero enables an
empty allowance. Reservations hold credits; saved delivery and consumption commit together.
The billing endpoint separates payer balance from channel usage. This is an allowance system,
not a payment ledger. See the [channel guide](multi-account/README.md) for recovery and
accounting limits. A failed response does not prove that a lost connection prevented delivery.

## Public content

Responses expose the fields needed to display and edit content. Internal similarity data,
generation locks, scraped source text and context pools are not ordinary display payloads.
Onboarding prefill deliberately includes titles used to review its proposed context.
Research informs generation but does not appear as a raw research dump in idea responses.
Saved timestamps use ISO strings; an immediate response may omit a timestamp until its
server-assigned value is available on the next read.

## Progress and success

Idea generation POST endpoints accept either ordinary JSON or `Accept: text/event-stream`.
Script regeneration at `POST /v1/scripts/:scriptId/regenerate` also supports that opt-in
stream. Without the header it returns one JSON result.

| Event | Meaning |
| --- | --- |
| `progress` | `{ stage, message }`: the operation has entered a real stage of work. |
| `chunk` | `{ text }`: draft script text, available on script regeneration streams. |
| `result` | The final success envelope after persistence and credit accounting. Script results contain canonical `id`, `title`, and `script`. |
| `generation_error` | `{ message, statusCode, code?, detail? }`: failure; unexpected internal details are masked. |

Heartbeat comments indicate connection liveness only. Neither draft chunks, EOF nor a
closed connection establish success. These POST streams have no `[DONE]` marker.
Clients must wait for `result` or reload saved content. Accepted work continues after a
client disconnects; never replay a paid mutation automatically because the response was
lost. A `charged:false` detail is provided only when the server has confirmed no delivery.

Initial script generation uses `GET /v1/scripts/stream/:projectId` with Bearer authentication and
`?token=` compatibility for native EventSource. Its channel is resolved from the project, followed by live
membership and editor checks. It is a separate transport from the named POST events above.

## Replacing a script

Regeneration preserves the previous manuscript until a complete replacement is ready.
Nonempty text with explicit provider `STOP` completion is required; interrupted, malformed
or timed-out output cannot replace the saved script. Streaming drafts remain provisional.
The JSON path waits for the complete provider response; the streaming path delivers text
as it arrives. Neither changes the authority of the final saved result.

## Provider interruptions

An explicit HTTP 503 rejection may retry up to three total attempts with backoff inside
a shared 120-second provider budget. Streaming retries apply only before output begins.
All attempts use one application reservation, with one delivery and settlement. Timeouts,
network failures, malformed output, quota failures, partial streams and saving failures
are not automatically replayed. There is no automatic model fallback. These limits do
not guarantee availability or control the provider's own billing for rejected requests.

Optional public YouTube cache reads and writes each wait at most one second before falling
through to the existing eight-second fetch budget. This limits optional cache waiting,
not the underlying database request. Saving content and credit accounting never use that
abandonment policy. Local tests do not establish live provider latency or availability.
