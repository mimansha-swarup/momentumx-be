# API communication

Idea generation combines channel context, optional research signals and idea generation. The research tabs remain separate reads. Research text is an input to generation; idea responses contain concepts and evidence, not a research dump.

## Public data

Idea list, generate and regeneration responses expose explicit display fields. Embeddings and batch identifiers remain in storage for similarity checks and batch management. Profile responses omit scraped website text, channel descriptions, prior-title pools and competitor-title pools; onboarding prefill deliberately retains top titles used by its context override. Account and project responses exclude generation locks and unknown storage fields.

## Progress without duplicate work

The existing idea generation POST endpoints accept `Accept: text/event-stream` in addition to ordinary JSON. Authentication, channel authorization and request validation remain before the controller. Streams emit:

- `progress`: `{ stage, message }`, emitted when the server enters real preparation, research, generation, provider-connection retry, formatting or saving work.
- `result`: the success envelope, emitted only after the service returns from persistence and credit settlement.
- `generation_error`: `{ message, statusCode, code?, detail? }`; unexpected internal errors are masked and server failures disclose only a confirmed `charged: false` marker.

Heartbeat comments keep the connection active; they do not imply progress. No draft idea is presented as saved. The server keeps its existing generation lock and finishes an accepted operation even if its client disconnects. A lost connection therefore means an unknown outcome: reload saved ideas before issuing another paid mutation. The client must never retry the mutation automatically. JSON clients retain the existing response envelope.

The research lookup can run while previous ideas are clustered. Embeddings already run concurrently and remain before persistence. This removes one avoidable wait without claiming to solve provider latency. No live generation or provider benchmarks are part of local verification.

Shared YouTube-cache reads and writes have a one-second waiting budget each. A cache outage falls through to the existing eight-second YouTube fetch budget; this bounds the optional wait, not the underlying Firestore RPC. Cache failures remain observed even if they arrive late. Authoritative content and billing writes are never abandoned by this cache policy.

Persisted idea timestamps are returned as ISO strings. An unresolved Firestore timestamp transform is omitted from the immediate generation response; the next saved-list read returns its authoritative timestamp.

## Script regeneration

`POST /v1/scripts/:id/regenerate` returns one JSON result. It uses Gemini's native `generateContent` endpoint rather than collecting a provider SSE stream. The prompt, model and generation settings are unchanged. One request is allowed up to 120 seconds, including reading its body; malformed responses, interruptions and timeouts are not automatically replayed. Only an explicit `STOP` completion with nonempty text can replace the saved script. Failed generation releases its credit reservation and preserves the previous manuscript. Initial script generation still streams text to the browser.

The legacy SDK's “Failed to parse stream” error indicates unconsumed event data at end of stream; it does not distinguish truncated data from unsupported event framing. The regeneration transport avoids that parser, without claiming to prevent upstream service failures. Google's [generation API reference](https://ai.google.dev/api/generate-content) documents the nonstreaming endpoint and completion metadata.

### Provider busy responses

Gemini requests may retry only an explicit SDK HTTP 503 rejection, at most three attempts with exponential backoff and jitter within the existing 120-second provider budget. This applies to stream opening and the complete JSON script-regeneration request. All attempts share the same application credit reservation; saving and settlement happen once. A timeout, network failure, malformed successful response, or interrupted stream is never automatically replayed. There is no automatic model fallback. This follows [Google's retry guidance](https://ai.google.dev/gemini-api/docs/troubleshooting); it improves transient-error recovery but cannot guarantee provider availability or the provider's own billing treatment of rejected requests.

### Script regeneration streaming

`POST /v1/scripts/:scriptId/regenerate` accepts `Accept: text/event-stream`.
Without that header its existing JSON response remains unchanged. The opt-in
stream uses named events: `progress` (`stage`, `message`), `chunk` (`text`),
`result` (the success envelope containing canonical `id`, `title`, `script`),
and `generation_error` (`message`, `statusCode`, optional `code`/`detail`).
There is no `[DONE]` marker on this transport. EOF alone is not success.

Chunks are provider text as it arrives, not a saved replacement. Only a nonempty
response with explicit `STOP` can replace the old manuscript. The final result
follows persistence and the existing credit settlement attempt. Disconnecting
stops delivery but deliberately does not cancel the operation: clients must
check the saved script before starting another paid attempt. Heartbeats indicate
connection liveness only. Existing authorization and reservation rules still apply.

This new streaming path uses Google's maintained `@google/genai` SDK. Legacy
JSON regeneration and other existing generation adapters retain their current
SDK for compatibility. The SDK's built-in retries are disabled; only explicit
pre-stream 503 rejection may retry (three attempts total, shared 120-second
budget). Quota failures, malformed streams, partial output, and save failures
are not replayed. This does not guarantee provider availability or eliminate
network interruptions. See [Google's SDK guidance](https://ai.google.dev/gemini-api/docs/libraries).
