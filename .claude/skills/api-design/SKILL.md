---
name: api-design
description: Implementation recipes for MomentumX endpoints — route file structure, controller pattern, auth wiring, and SSE controller. Use when building new endpoints.
---

# API Endpoint Implementation Reference

Read `.claude/rules/api-design.md`, the relevant `docs/features/*/api.md`, and the nearest
current route/controller before editing an endpoint. Routes and schemas are authoritative
for exact signatures; do not reproduce a stale route inventory here.

## Wiring

Instantiate dependencies once in `src/container.ts`; routes import its controller.
Register feature routers in `src/routes/v1/index.ts`. Preserve `.js` relative import
extensions. Apply authentication before account resolution, then the role required by
the operation. Discovery/bootstrap, invitation and public-preview routes have intentional
exceptions: inspect the existing router rather than applying blanket middleware.

Controllers validate, delegate and call `res.sendSuccess`. Wrap async handlers with the
existing `asyncHandler`; let typed service errors reach the shared error handler instead
of flattening them in a catch-all `sendError`. Obtain identity from authentication and
channel context from the authorized middleware via `ownerOf(req)`. Derive links for an
existing resource from storage rather than trusting replacement IDs in its body.

## Streams

Initial script GET streaming prefers Bearer authentication with query-token compatibility,
resolves its channel from the project and requires editor permission. It uses JSON-encoded
text chunks and the raw `[DONE]` terminator. That terminator alone does not prove saving.

Opt-in POST idea/regeneration streams use named progress/result/error events; script
regeneration also emits draft chunks. They have no `[DONE]` marker. Preserve the transport
specific to the endpoint; see `docs/api-communication.md` and the script API reference.
Validate before flushing headers; after opening, use the transport's error event and always
close it. Save and account for output before reporting final success. Never prescribe
post-success persistence or automatic client replay of a paid mutation.
