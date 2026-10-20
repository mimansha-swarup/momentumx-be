# Operational readiness

Local implementation and tests do not establish production readiness. Verify these gates
against the target environment before rollout or destructive maintenance.

## Coordinated rollout

- Coordinate frontend, Vercel API, Render API/SSE and separate Functions releases.
  Render serves the entire API; confirm its dashboard environment and deployed revision.
  Deploy rules and indexes separately from those artifacts.
- Verify all declared composite indexes are READY with `inventory-indexes.ts --check`,
  then exercise the actual authenticated API queries. The emulator does not enforce
  composite indexes; neither source declarations nor emulator tests prove readiness.
- Verify deployed single-field exemptions against `firestore.indexes.json`:
  `accounts.members`, `context.websiteContent`, `context.channelDescription`,
  `context.competitors`, `ideas.embedding`, `invites.expiresAt` and
  `users.legacyChannelSnapshot`. Composite inventory does not check these, rules or access.
- Use the [Node 24 / gen2 Functions runbook](../../functions/README.md) for staged
  deployment, guarded legacy overlap and rollback. Verify real event delivery, service
  permissions and retry/error monitoring; API deployment does not deploy Auth triggers.
- Audit enabled identity providers and verified-email behavior. Stage wrong-email and
  unverified-provider invitation acceptance, public preview, single-use/expiry/revocation,
  member removal, ownership transfer and direct Auth deletion.
- Stage account switching, multi-tab isolation, viewer restrictions, initial script SSE,
  content persistence and reservation/charge/monthly-reset behavior across both API hosts.
  Keep enforcement disabled unless an allowance is intentionally configured; explicit
  numeric zero enables enforcement with no paid allowance. Description/thumbnail/short
  prices default to 2/1/1 and remain configurable.
- Compare API/feature contracts and `.claude/rules/api-design.md` plus
  `.claude/rules/firestore-conventions.md` with the final implementation.

Traffic protection is a separate release gate from monthly credits. Current per-IP limits
use in-memory state; verify behavior across API instances and hosts, and assess shared,
authenticated-user/channel limits before exposing paid provider work to production traffic.
A monthly allowance does not replace request-rate or abuse protection.

Direct Auth deletion reconciles membership asynchronously. Missing last owner or billing
payer freezes a channel for recovery. Verify the claimant and repair both ownership and
billing before clearing the orphan marker; preserve content during recovery.

## Cleanup gates

| Change | Required evidence |
| --- | --- |
| Remove legacy indexes | Inventory deployed indexes, including abandoned topics indexes; prove account-scoped queries stable and retain rollback indexes throughout the compatibility window. Deletion requires a separate reviewed operation followed by deployed-inventory verification; recreation needs another build window. |
| Remove legacy user channel fields | Audit every reader/writer. First-channel creation still imports legacy context: remove that dependency or verify every user's channel-context completeness first. Snapshot allowed fields, rehearse restore on a copy and retain recovery data for 90 days before separately authorized deletion. |
| Require headers for reads | Measure headerless requests over the compatibility window and verify all clients send explicit channel headers. Read fallback remains enabled; writes already require explicit context. |
| Reduce event storage | Inventory old append-only events and previously used slots separately; the bounded pool constrains new writes only. Recheck billing/storage limits before a plan downgrade. |
| Reclaim invitations | Expiry is enforced transactionally, independent of TTL. Spark operation needs bounded manual cleanup when volume warrants. Enable billing-dependent TTL only after verifying target-plan support and deployment. |

## Maintenance commands

Run from the backend root with the intended environment. Inspect scope and dry-run output
before explicitly enabling writes; keep credentials and private backup data outside git.

```sh
npx tsx --env-file=.env scripts/legacy-channel-cli.ts audit
npx tsx --env-file=.env scripts/legacy-channel-cli.ts snapshot
npx tsx --env-file=.env scripts/legacy-channel-cli.ts restore
npx tsx --env-file=.env scripts/inventory-indexes.ts --check
npx tsx --env-file=.env scripts/channel-maintenance-cli.ts purge ACCOUNT_ID --limit=2000
npx tsx --env-file=.env scripts/channel-maintenance-cli.ts expired-invites --limit=200
```

Legacy channel audit/snapshot/restore default to dry-run. `--limit=N` (default 1,000;
maximum 10,000) bounds a run; continue with `--after=uid` from `nextCursor`.
Only `--apply` on snapshot/restore writes. There is no field-deletion mode. Snapshots
preserve the first copy of the eleven allowed legacy fields with a 90-day retain-until
marker. Restore fills missing legacy fields only and preserves current values. Oversized
candidates require a verified export. Snapshot expiry does not delete data automatically;
retention cleanup is a separate authorized operation after the recovery window.

Channel purge requires a tombstoned channel and is bounded per collection. Repeat its ID
while `incomplete` is true. It includes membership markers, usage and invitations, retaining
the tombstone and bounded audit events. Expired-invite scans return `nextCursor`; pass
`--after=TOKEN` until null, even for pages containing only live invitations. Keep cursors
private. These commands default to dry-run; `--apply` enables writes.

Preserve private recovery backups outside the repository for the full 90-day window.
Before a restore, verify the target environment, ownership and document revisions; rehearse
on a copy and preserve newer edits. Backup retention does not authorize deletion or rollback.

`EVENT_RETENTION_SLOTS` accepts 0–100,000, default 10,000; zero disables storage.
New telemetry randomly replaces fixed slots and omits metadata over 4 KiB. This is sampled
telemetry, not a chronological audit log. Reducing slots does not delete old slots or
legacy documents; no retention guarantee depends on TTL.

## Current operational limitations

Artifact persistence, payer consumption and channel usage commit atomically. Lock release
can fail and leave a lock until expiry, without losing or duplicating delivered accounting.
Monitor release failures and stage retry/expiry behavior. Stateless paid packaging requires
settlement before returning; zero-cost prefill has no durable artifact, and sufficiently
late loss of its bounded free receipt can omit usage. This optional allowance system is
not a purchased-credit ledger.

Some supporting state can lag behind saved content: pipeline status, stale indicators,
thumbnail hints, script/idea synchronization and personal lifetime counters. A failure in
these updates does not mean the content failed to save. Monitor `pipeline_transition_failed`, `stale_cascade_failed`,
`stale_cascade_clear_failed`, `thumbnail_hint_refresh_failed`, `script_idea_sync_failed`
and `lifetime_stats_failed`; verify affected state before retrying generation.

## Reproducible local checks

```sh
npm test -- --runInBand
npm run typecheck
npm run build
npm --prefix functions run build
npm run test:runtime
```

Real Firestore contention checks use `npm run test:emulator` with the dedicated localhost
emulator at `127.0.0.1:18089` and the fixed `demo-momentum-review` test project. Local
checks do not verify external model/YouTube behavior, deployed identity configuration or
provider event delivery. Use the Functions runbook for its independent checks.
