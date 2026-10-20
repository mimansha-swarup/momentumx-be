# Multi-account operational readiness

Local code and test completion does not establish production rollout or authorize data
removal. This checklist records the remaining release gates; no deployment or destructive
cleanup was performed by this implementation.

## Sharing release gates

- **Index rollout verified (2026-10-18, 07:35:21 UTC).** All 22 declared composites
  are READY on `video-topic-5bace/(default)`; independent `inventory-indexes.ts --check`
  exited zero with no pending definitions. Three missing invitation composites were
  created additively with user approval: `email/status/expiresAt`,
  `accountId/status/expiresAt`, and `accountId/email/status` (all ASCENDING,
  COLLECTION scope), preserving the existing 19. Before repair, the first two exact
  source query shapes failed with `FAILED_PRECONDITION`; the equality-only third
  already succeeded through index merging. After repair, independent live probes of
  all three shapes returned zero results using synthetic nonexistent account/email
  selectors, including the expiry filters and 100-result limits used by invitation
  lists. This verifies live index/query readiness, not authenticated API or browser
  lifecycle behavior. No Auth identities or live records were created or modified.
  Local query-contract tests validate declarations only; the Firestore emulator does
  not enforce composite indexes. Neither alone proves live index readiness.
- Deploy the separate Functions artifact including `onDeleteUser`, and test deletion of
  an ordinary member and billing owner in staging. API rollout alone does not deploy it.
- Audit Firebase enabled identity providers. Acceptance always requires verified email;
  manually exercise unverified-provider and wrong-Google-account flows in staging.
- Confirm public token preview, authenticated single-use acceptance, expiry, revocation,
  roles, ownership transfer and member removal through the browser and deployed API.
- Links expire after seven days, enforced in `SharingRepository.accept` — not by TTL.
- **The `invites.expiresAt` TTL policy was REMOVED from `firestore.indexes.json`, and
  this is a pending follow-up.** Firestore TTL requires billing; on the current Spark
  plan the whole `firestore:indexes` deploy failed with
  `403 … has billing disabled` before creating a single composite index — so the TTL
  declaration was blocking the two `invites` indexes the members screen needs. The flag
  was dropped and the field kept as a plain single-field exemption, which deploys fine.
  Cost: expired invitations are never auto-reclaimed. Nothing about ACCESS changes —
  expiry is enforced in code, and `purgeAccountData` now deletes a channel's invites.
  **On moving to Blaze, restore `"ttl": true` on that override and redeploy.**
- Direct auth deletion is reconciled asynchronously. Missing last owner or billing payer
  freezes the channel explicitly (`orphanedAt`/`orphanedReason`), preserving content for
  operator recovery. No app login-delete flow is exposed. Restore ownership/billing only
  after verifying the claimant; do not clear the orphan marker without repairing both.

## Phase 10: safe preparation completed

The code enforces channel tenancy and role gates, retains author ids, keeps the
createdBy/accountId index coexistence inventory, and declares invite indexes.
Functions collection constants now include accounts for the deletion reconciler;
EVENTS was already synchronized. Orphaned channels are excluded from bootstrap and
normal discovery. The safe default remains read-header compatibility; writes require
an explicit channel, with named identity/bootstrap/invite exceptions.

Phase 06b's historical reverse-resync prerequisite is superseded by its recorded
dev-data reset/no-migration decision; no obsolete migration script was added.

## Phase 10: remaining preparation and operational gates

| Item | Required evidence/work before change |
| --- | --- |
| Legacy indexes | Inventory the live database, including abandoned topics indexes; prove production accountId queries stable. Removing indexes is an explicit later operation, then verify the deployed inventory. |
| Legacy channel fields | Audit every user-profile read/writer, snapshot exactly the legacy fields before deletion, test restoration on a copy, and retain snapshot 90 days. Snapshot/restore tools are prepared below; no live execution or field deletion occurred. `ensureDefaultAccount` still imports legacy fields on first bootstrap, so reader removal or verified per-user context completeness is an explicit prerequisite. |
| Strict read header | Measure headerless requests over the compatibility window and confirm all clients support explicit account headers; then change fallback behavior. Current code retains fallback. |
| Events retention | New telemetry writes use a global bounded sample (default 10,000 slots; max 4 KiB metadata). Existing append-only documents are untouched and must be inventoried separately before downgrade. |
| Documentation | Feature specs and pipeline spec now describe accountId tenancy and retain createdBy authorship. Final production behavior must still match those contracts. |
| Functions deployment | Build independently, deploy trigger, and confirm retry/error monitoring plus orphan-recovery runbook in staging. |
| Invitation storage | On Spark, expired/revoked documents require a deliberate bounded cleanup job if volume warrants; authorization already rejects expired invites. |

Production measurements, a staged restore rehearsal, deployment and destructive
cleanup remain explicit follow-up work. Passing local tests is not evidence for deleting
indexes, erasing legacy data or downgrading the billing plan.


## Prepared commands (maintenance not executed against live data)

Use the existing environment-loading convention from the repository root:

```sh
npx tsx --env-file=.env scripts/legacy-channel-cli.ts audit
npx tsx --env-file=.env scripts/legacy-channel-cli.ts snapshot
npx tsx --env-file=.env scripts/legacy-channel-cli.ts restore
npx tsx --env-file=.env scripts/inventory-indexes.ts
npx tsx --env-file=.env scripts/inventory-indexes.ts --check
```

The first three default to dry-run and print counts, never profile values or credentials.
`--limit=N` (default 1,000; maximum 10,000) bounds a run; use its `nextCursor` as
`--after=uid` to continue. Only explicit `--apply` on snapshot/restore writes anything.
There is deliberately no field-deletion mode. Run snapshot before any separately reviewed
cleanup and prove restore on a staging copy. Snapshot stores only the eleven documented
legacy fields, preserves the first snapshot, and records `capturedAt`/`retainUntil` (90
days). Restore fills missing legacy fields only, preserves current values and filters out
unknown snapshot fields. Neither mode modifies author ids, identity, stats, current
channel documents or credentials. Oversized snapshot candidates are refused; use a
verified export for those records. The unindexed snapshot is not auto-deleted: retention
cleanup is another explicitly authorized operation after the recovery window.

Index inventory calls only the Firestore REST list endpoint and prints live index
names/states/fields beside the declared index list. It does not deploy, build or delete
indexes. `--check` exits nonzero if any declared composite is absent or not READY;
run it against the target environment before rollout and then verify authenticated
API requests. It checks composite metadata, not single-field exemptions, rules, or
authorization. Inventory was run live for the dated index repair above; the maintenance
commands remain unexecuted. Both scripts use the existing Firebase service credential; do not commit `.env`
or the service credential. Snapshot data stays in Firestore, not a local credentials dump.

`EVENT_RETENTION_SLOTS` is an integer 0–100,000; default 10,000, zero disables event
storage. New writes randomly replace a scattered fixed slot and retain author/account
attribution. This is sampled telemetry, **not an audit log** or chronological retention.
Event slot ids are a deliberate bounded-storage exception to normal content UUIDs.
Metadata over 4 KiB is omitted, yielding roughly a 50 MiB payload ceiling at the default
pool size (indexes/storage overhead are additional). Existing legacy event documents are
not deleted. Reducing the configured slot count does not remove previously used slots;
the total pool remains bounded by the highest configured count, plus legacy documents.
No retention guarantee relies on billing-dependent TTL.


## Final local validation (2026-09-26)

- Backend: **1,243 tests / 75 suites pass**, independently rerun after final fixes.
  Included coverage spans sharing HTTP routes, transactional invite/membership races,
  ownership deletion, orphan reconciliation, malformed balances, reservation/refund
  behavior, stale generation persistence fences, snapshots/restores and bounded telemetry.
- Frontend: **174 tests / 24 files pass**, including **19 mounted checks** (15 independent
  lifecycle checks and four actual pipeline screens) and **11 stream parser/status checks**.
- Independent backend acceptance: **35 adversarial checks pass**, including actual delayed
  script regeneration, hooks and all four packaging outputs through the real runner and
  repositories. These are included in the backend suite count, not additional totals.
- Separate external review configurations: **22 checks pass** (billing 5, sharing 11,
  Phase 10 safety 6).
- Backend, frontend and separate Functions builds pass. Standalone maintenance scripts
  pass TypeScript checking. Generated backend `dist` is refreshed; Functions `lib` remains
  ignored build output. Frontend lint reports zero errors and three existing Fast Refresh
  warnings; its build still reports two CSS warnings and dynamic-import warnings.
- One earlier full backend run reported an unexplained `Parse Error: Expected HTTP/,
  RTSP/ or ICE/` in `tests/integration/accounts.route.behaviour.test.ts:148` (the GET
  account membership case). The isolated nine-test suite and the next complete
  1,243-test run passed without edits. No cause was established; this is not claimed
  to be a proven harness-only issue or an uninterrupted clean run.

These checks use local fixtures/mocks and do not prove real Firestore contention,
external model/YouTube behavior, production identity-provider configuration or a live
rollout. Local acceptance is complete; no deployment or live-data operation is implied.

## Acceptance matrix across the plan

| Phase | Local outcome | Remaining operational gate |
| --- | --- | --- |
| 00–01 | Deny-all Firestore rules and foundation/input/auth fixes are in the repository. | Confirm deployed rules/environment match the reviewed artifacts. |
| 01b | All generation goes through the common reservation/settlement seam. | Deploy the same version to both API and SSE hosts. |
| 02–03 | Account schema, index declarations and accountId writes are implemented. | Inventory live indexes and confirm required indexes READY before dependent traffic. |
| 04 | Backfill was explicitly dropped in favor of a historical development-data reset. | No reset or data deletion was executed in this work; reconfirm current data before any future destructive operation. |
| 05–06b | Membership-scoped access, account APIs, deterministic packaging keys and channel context are implemented. | Deploy and verify per-channel data/context against the actual environment. Legacy bootstrap import still blocks blanket field removal. |
| 07 | Switch/reset/bootstrap, stale-request isolation and explicit generation pass frontend acceptance. | Staged multi-tab/account/SSE verification after coordinated rollout. |
| 08 | Configurable prices and optional allowance enforcement; balances, reservation/success charge, transactionally fenced persistence and frontend error handling pass local acceptance. | Configure allowance only when desired, deploy shared API/SSE version, and verify live reservation/charge/reset behavior. |
| 09 | Invite/member/role lifecycle and viewer states pass local backend/frontend acceptance; all 22 declared indexes verified READY on 2026-10-18. | Deploy auth-deletion Function; audit sign-in providers and stage wrong-email/removal/ownership flows. |
| 10 | Non-destructive audit/snapshot/restore, index inventory, bounded telemetry and documentation preparation complete. | Live evidence, backup/restore rehearsal, removal of legacy bootstrap dependency, approved field/index cleanup, and zero-headerless-client evidence remain unperformed. |

## Remaining operator actions

1. Check the real environment and deployed index/rules inventory; retain old indexes
   throughout the compatibility period. Phase 04's reset was not run here.
2. Coordinate frontend, API host, SSE host and separate Functions releases; verify auth
   providers and stage invite, account-switch, ownership-deletion and generation flows.
3. Keep metering disabled until an allowance is configured. Defaults for description,
   thumbnail and shorts are 2/1/1, all configurable. Set optional `VITE_SUPPORT_EMAIL`
   if a support contact link is wanted; no payment/upgrade flow was introduced.
4. Before destructive Phase 10 cleanup, remove or retire the legacy bootstrap reader,
   snapshot allowed fields, rehearse restoration, retain recovery data for 90 days,
   verify production stability and headerless-request counts, then authorize cleanup.
   Inventory old append-only events separately; the bounded pool limits new writes only.


Known settlement limitation: content persistence and successful billing settlement are
separate transactions. A settlement outage can leave saved output uncharged; the runner
logs that failure. Paid reservations have no 256-receipt ceiling. Free usage receipts are
bounded to 256 with unspecified eviction order; a late free run whose receipt and lock
both disappeared cannot contribute usage. This is not a purchased-credit ledger.

## Backend hardening — 2026-10-18

The API runtime matrix covers Node 22/24/26; `.nvmrc` recommends 24. The former
Node 26 Firebase import failure is fixed by updating supported JWT dependencies
(jsonwebtoken 9.0.3, jws 4.0.1, jwa 2.0.1), without a shim. Firebase Functions
retains its separate Node 22 deployment engine. See the root README for hosting
selection and the runtime upgrade checks. Local verification passed on Node 22.23.3,
24.22.0, and 26.11.1: all 1,744 tests (87 suites) on each, real dependency/JWT
signature checks, and `npm run dev` returning HTTP 200 from `GET /`. Type checks
and the API build passed on Node 24; a clean isolated Functions install/build
passed on Node 22. Startup checks did not exercise live external services.

Invite previews return 404 for missing, deleted or orphaned channels, even after a partial
purge. Owner membership changes and Auth deletion atomically write a per-UID
`membershipChanges` marker. Acceptance rejects older links independently of profile email,
using full timestamp precision; newly issued links remain usable. One fixed-size marker per
changed UID remains until channel purge, avoiding an account-document size ceiling.

Maintenance is manual and dry-run by default:

```sh
npx tsx --env-file=.env scripts/channel-maintenance-cli.ts purge ACCOUNT_ID --limit=2000
npx tsx --env-file=.env scripts/channel-maintenance-cli.ts expired-invites --limit=200
```

Only a tombstoned channel can be purged. Each invocation is bounded per collection;
repeat the same account ID while `incomplete` is true. Purge includes membership markers
and usage, retains the account tombstone and bounded audit events, and safely resumes after
a committed page followed by failure. Expired-invite scans return `nextCursor`; pass it as
`--after=TOKEN` until null, including pages containing only live invitations. Keep cursor
output private. `--apply` explicitly enables writes; no apply command ran here. No worker,
scheduler or live cleanup was introduced.

Real contention acceptance uses a dedicated localhost Firestore emulator and the test's
fixed `demo-momentum-review` project. With the emulator listening on 127.0.0.1:18089, run
`npm run test:emulator` under Node 22. Ordinary test runs skip these 17 cases. The separate
emulator run passed all 17, including concurrent allowance claims, stale-email membership
changes, numeric-string/malformed settlement counters and enabling enforcement mid-run.
Frontend evidence above is historical; frontend was not changed or rerun in this pass.

Final local backend gate: **1,703 tests passed across 85 suites**, with 17 emulator cases
skipped by default and passed separately. The independent sharing acceptance contributes
29 passing cases. API build, separate Functions build, source/test/Functions typecheck,
standalone maintenance-script compilation and `git diff --check` passed. Generated API
and Functions outputs were rebuilt from the final production source.

One earlier full run returned unexplained bare HTTP 501 responses in the account
middleware suite. Its unchanged assertions passed in isolation and subsequent full runs;
a final diagnostic run captured 480 server listening/request events without a 501 or
parser error. Cause is not established and this is not classified as an application or
harness defect. Historical failure, diagnostic and emulator logs were temporary and are
not retained. No deployment, live mutation, purge or expired-invite cleanup was executed.

### Follow-up recovery fixes — 2026-10-18

Context saves and derived channel-name/handle updates now recheck the parent channel and
the actor's current editing permission inside their write transaction. Delayed enrichment
cannot recreate purged context or update a deleted/orphaned channel after access changes.
Bootstrap and additional-channel creation retain their atomic creation paths.

Zero-cost prefill remains available when a reduced allowance falls below already consumed
credits. Generation locks carry the original pipeline rollback state, so successive expired
runs that fail restore the stable state instead of leaving a spinner without an active lock.
Explicitly stable states (including stale or awaiting selection) are preserved. For older
locks without a snapshot, a failed takeover resets only work with no persisted artifact;
a surviving stale reason restores stale state, and saved choices remain intact.

Maintenance examples above load `.env` explicitly; no maintenance command was executed.

Follow-up final validation: **1,744 tests passed across 87 suites**. The normal suite skips
34 emulator checks; all 34 passed separately (17 baseline and 17 independent recovery/
billing cases, including legacy locks). Independent context-recovery acceptance passes
26 checks, with 116 passing in its targeted sibling gate. API/Functions builds, complete
typecheck, standalone scripts compilation and diffcheck passed; generated outputs were
rebuilt after the final production change. Historical validation logs were temporary
and are not retained as repository evidence.
The extra actor argument required mock expectation updates; no authorization assertions
were weakened. No unresolved scoped product findings remain. The earlier unexplained
HTTP 501 observation above is retained; it did not recur in these validation runs.

To reproduce local package checks, run `npm test -- --runInBand`, `npm run typecheck`,
`npm run build`, and `npm --prefix functions run build` from the backend root.
The emulator checks use `npm run test:emulator` with the localhost emulator described
above. These commands are provided for reproduction; this documentation cleanup did
not rerun validation or establish new passing results.
