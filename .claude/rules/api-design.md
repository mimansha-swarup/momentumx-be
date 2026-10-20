---
name: api-design
description: REST conventions and response standards for the MomentumX API — URL structure, HTTP methods, auth pattern, and response shape.
---

# API Design

## Sources and request boundaries

Read current `src/routes/v1/`, validation schemas and the relevant `docs/features/*/api.md`
for exact endpoints. Shared transport behavior lives in `docs/api-communication.md`;
channel/role/billing behavior lives in `docs/multi-account/README.md`. Do not maintain a
second static endpoint inventory in agent instructions.

Use `/v1`, kebab-case paths, plural collection nouns, POST for new generation and PATCH
for partial edits. Existing initial script GET generation is a compatibility exception
to read-only GET semantics. Deletion behavior is resource-specific: channel deletion
marks a tombstone; physical purge is separate. Never assume every delete uses `isDeleted`.

Authentication sets identity; channel middleware validates `X-Account-Id` and live
membership; role checks follow. Never read a client channel ID outside the authorized
resolution path or accept identity from body/query. Headerless read compatibility remains;
writes require explicit channel context. Discovery/bootstrap, invitations and public
previews retain their documented exceptions. `X-Account-Id` must remain allowed by CORS.

SSE auth prefers Bearer and retains query-token compatibility. Initial script streaming
resolves the channel from its stored project and requires editor permission. New code must
not derive tenancy from stream query parameters. Research reads consume quota and also
require editor. Content reads/exports allow viewers; membership/billing/channel management
requires owner as specified by the existing routes. Personal channel creation is independent
of the current channel's role. Public invite preview reveals no email/private channel data.

## Responses and errors

Use the shared response helpers:

```typescript
// success
{ success: true, data: unknown, message?: string, meta?: object, warning?: string }
// error
{ success: false, message: string, code?: ErrorCode, detail?: unknown }
```

Async controllers use `asyncHandler` and propagate typed errors to the shared handler.
Use 400 for invalid input, 401 for missing/invalid authentication, 402 for exhausted
configured allowance, 403 for authorization refusals, 404 for missing resources, 410 for
deleted channels and 503 for unavailable provider/delivery work. Preserve the endpoint's
specific error codes rather than flattening them into a generic 500.

- `account_forbidden`: no live membership; `wrong_account`: resource belongs to another
  channel the caller can access, with safe switch details; `role_forbidden`: membership
  exists but capability is insufficient. Use the shared cross-account helper.
- Arbitrary internal details and codes never cross a 5xx boundary. Only a confirmed
  `charged:false` assurance may be exposed; an uncertain delivery is not proof of no charge.
- Normalize/validate query inputs and resource IDs; type assertions do not validate input.
- For existing resources, resolve owning project/resource links from storage. For creation,
  validate all supplied links against the active channel. `createdBy` is not authorization.

## Streaming and paid work

Initial script GET uses JSON-encoded text and raw `[DONE]`; opt-in POST streams use named
progress/result/error events, plus script-regeneration chunks, with no `[DONE]` marker.
Keep these protocols separate. Validate before flushing headers, always close opened
streams, and never claim saved success before persistence and accounting. A disconnected
client must reload saved output before starting another paid mutation.

Use the existing reservation/delivery/settlement path. Saved artifacts, channel usage and
payer consumption commit atomically; locks prevent superseded workers overwriting results.
Allowance enforcement is optional and zero is an enabled empty allowance. Credits are not
a payment ledger or a substitute for traffic-rate protection. No client retries of paid
mutations may be inferred from a 503 alone.
