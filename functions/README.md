# Firebase Auth functions: Node 24 / second generation

This package targets Node 24 with `firebase-functions` 7.4.0. It exports
`onCreateUserV2` and `onDeleteUserV2`, using the modular `v2/identity` API.
Both run in `us-central1`, use concurrency 1, handle default-project users only,
and retain the previous disabled automatic-retry policy. Failures still reject
and are logged; operators must reconcile failed events. Duplicate delivery is
possible even without automatic retries.

**Release status is inconsistent in official sources:** the Auth guide labels
these triggers Preview, while SDK 7.4.0 release notes say GA. Node 24 itself is
stable. Resolve the provider support/SLA status before production rollout. The published SDK 7.4.0 and Firebase CLI 15.34.0 support these
triggers. This repository has only been validated locally: project permissions,
Eventarc provider availability and real delivery require a staging deployment.
No deployment is performed by the local checks.

Before production rollout, check the current production dependency vulnerability inventory
and remediate or explicitly assess unresolved advisories. A passing build does not establish
dependency security.

On signup, the handler creates a profile only when one is missing. Duplicate events
preserve existing names, counters and creation dates. The API fills missing profile
fields when necessary. Deletion retains the transactional membership
removal, membership-change marker, deterministic payer reassignment and orphan
freeze; it never deletes channel content. Repeated deletion skips an already
removed member. These are lifecycle handlers, not blocking Auth functions.

## Local verification

From the repository root, using Node 24 (no credentials needed):

```sh
npm ci
npm ci --prefix functions
npm run build --prefix functions
npm test -- --runInBand tests/unit/functions tests/unit/backend-contract.acceptance.test.ts tests/unit/security-pov.acceptance.test.ts
```

## Controlled rollout (operator runbook; not executed)

A gen1 function cannot be upgraded in place under the same name. A targeted
new-name deployment keeps old deployed functions running, so both generations
can receive each event. **Do not overlap the original merge-based create handler
with this version:** the original can reset counters/profile fields. First ship
the same atomic-create guard to the legacy Node 22 functions.

Before touching production, reproduce this whole sequence in a separate staging
project. Record the actual deployed regions, service accounts, runtime settings
and legacy source artifact. If the old region differs from `us-central1`, adapt
both artifacts before deploying. Gen2 uses the Compute default service account
instead of the gen1 App Engine default; verify least-privilege Firestore access,
Eventarc invocation permissions, required APIs and billing. Do not blindly grant
Editor. Confirm provider support status and whether Preview limitations apply before production.

Prepare an isolated, reviewed Node 22 legacy artifact before rollout. It must retain the
existing deployed names and regions, preserve existing profiles on duplicate creation,
and retain the membership and billing recovery behavior of deletion. Build and verify it
separately without changing the current Node 24 artifact. Keep that guarded artifact as
the rollback target. Do not generate a deployment artifact by blindly rewriting source text.

Supply an explicit project ID in every deployment; never rely on a cached alias. The
commands below describe operator steps and have not been executed by local verification.

1. With Node 22, from the prepared legacy artifact directory, deploy only the guarded legacy functions using
   Firebase CLI 15.34.0:
   `firebase deploy --project PROJECT_ID --only functions:onCreateUser,functions:onDeleteUser`.
   Verify the updated handlers are serving, old revisions have drained, and
   repeated creates preserve existing profile data. Keep this guarded artifact
   as the rollback target; do not roll back to the unsafe merge implementation.
2. With Node 24, from this repository root, deploy only the new functions:
   `firebase deploy --project PROJECT_ID --only functions:onCreateUserV2,functions:onDeleteUserV2`.
   Use CLI 15.34.0 or a later version whose Auth Eventarc support was verified.
   Avoid an unfiltered deployment, which can propose deletion of legacy functions
   absent from the current source. Inspect the planned changes before accepting.
3. During overlap, verify both generations' logs, new signup profile creation,
   duplicate preservation, deletion member removal, membership markers, payer
   reassignment and orphan freezes using dedicated staging/test accounts. Verify
   the real v2 event payload and default-tenant filtering. Unit mocks cannot prove
   provider delivery. Observe delivery/permission failures and reconcile missed
   events before retiring legacy functions.
4. Only after verified production observation, explicitly retire the old
   `onCreateUser` and `onDeleteUser` in their recorded region. This is a separate
   destructive operator action; do not delete users or channel data during it.

Rollback before retirement: keep the guarded legacy handlers active and remove
only the new v2 functions. After retirement: redeploy the guarded Node 22 artifact,
verify delivery, then retire v2. Generation changes cannot reuse a live name.
Never revert counters, profiles or membership changes automatically: successful
invocations remain committed, and missed events must be reconciled. Avoid a
period with neither generation active. Do not use bulk `deleteUsers` for delivery
verification: Firebase does not emit per-user deletion events for that API.
A first sign-in via a custom token also does not emit a creation event.

## References (verified 2026-10-18)

- [Auth triggers, Preview status and event semantics](https://firebase.google.com/docs/functions/auth-events)
- [Generation migration, names and service-account changes](https://firebase.google.com/docs/functions/2nd-gen-upgrade)
- [Runtime support: Node 24 is Cloud Run functions only](https://docs.cloud.google.com/functions/docs/runtime-support)
- [SDK 7.4.0 release notes (GA claim)](https://github.com/firebase/firebase-functions/releases/tag/v7.4.0)
- [Published Functions SDK 7.4.0](https://registry.npmjs.org/firebase-functions/7.4.0)
- [Published Firebase CLI 15.34.0](https://registry.npmjs.org/firebase-tools/15.34.0)
