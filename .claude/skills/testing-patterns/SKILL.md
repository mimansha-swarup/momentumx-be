---
name: testing-patterns
description: Reference for Jest unit tests and Supertest integration tests in MomentumX — mock setups, response assertions, auth and SSE testing. Use when writing tests for services, controllers, or utilities.
---

# Testing Patterns Reference

## Layout and isolation

Jest uses `jest.config.cjs`, ts-jest and `tests/setup-env.cjs`. Existing suites live under
`tests/unit`, `tests/integration` and `tests/emulator`; do not create `src/__tests__`.
Reuse `tests/helpers/fake-firestore.ts` and nearby current suites before adding mocks.
Supertest imports the Express app from `src/app.ts`.

Mock `src/config/firebase.ts` for isolated unit tests so service-account parsing and live
initialization cannot run. Mock generation helpers at `src/utlils/ai.ts`, or the actual SDK
adapter used by the path (`@google/generative-ai` or `@google/genai`). Model streams need
completion metadata when the path validates completion. YouTube adapters use `fetch`, not
`googleapis`; shared cache state must be isolated too. Never call paid or live services
merely to run a regression suite.

## Behavioral checks

Cover valid output, bad input, 401 authentication failures, 403 channel/role refusals,
404 missing resources, and shared error propagation. Two users in one channel can share
content; a foreign channel cannot. Test authorship and membership separately. Preserve
`wrong_account` for another channel the caller belongs to and `role_forbidden` for a
viewer attempting mutation. Test explicit write headers and channel-switch isolation.

For generation, verify draft output does not count as saved, interrupted generation
preserves previous content, and delivery/accounting remain atomic. Test the endpoint's
actual SSE protocol: initial GET uses JSON text plus `[DONE]`; opt-in POST uses named
`progress`, `result`, `generation_error` events and script-regeneration `chunk` events.
EOF alone is not successful delivery. Do not make all streams use one terminator.

Use fake Firestore for fast behavior checks and dedicated emulator tests for transaction
contention; emulator success does not prove deployed composite-index readiness. Choose
focused meaningful regression cases rather than mirroring private methods. Read
`docs/multi-account/operational-readiness.md` for local check commands and their limits.
