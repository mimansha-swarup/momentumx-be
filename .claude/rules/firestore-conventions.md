---
name: firestore-conventions
description: Firestore-specific rules for data access, timestamps, IDs, collection naming, and batching in MomentumX.
---

# Firestore Conventions

Use repositories for application Firestore access. Auth lifecycle functions and explicit
operator tooling have their own reviewed data access; do not put database calls in HTTP
controllers/services. Import the configured Admin SDK and enum collection names. Current
schemas live in `src/types/routes/`; current collection names in `src/constants/collection.ts`.

## Identity and permissions

`accountId` scopes content access; `createdBy` is authorship only. Bound channel queries
and check loaded/linked resources against authenticated `RecordOwner` from `ownerOf(req)`.
Use the shared cross-account helper so `wrong_account` and `account_forbidden` remain
consistent. Never return another channel's content or authorize by author equality.
Membership, ownership, billing and context-enrichment writes recheck current permissions
inside their transaction where the operation requires it.

## IDs, timestamps and atomicity

Validate document IDs before constructing paths. Use UUIDs for generated ideas/scripts,
Auth UIDs for user documents, and the project ID for packaging. Packaging uses point reads
and converges on one document across generation/editing paths; do not reintroduce auto-ID
creation or lookup queries. Server timestamps record stored lifecycle times; local dates
may be used for query boundaries and explicitly defined retention windows.

Batch independent multi-document writes. Use transactions for read/check/write invariants,
including memberships, project links, generation ownership and billing. Generated artifacts,
payer consumption and channel usage commit together through the existing delivery path;
never split those into independent writes. Preserve prior output on rejected delivery.

## Lifecycle

Channel profile/context is separate from identity. First-channel compatibility still reads
legacy user context; do not delete those fields without the readiness gates. Billing,
invites, monthly usage, membership markers and shared public YouTube cache are active data,
not unused migration placeholders. Invitations enforce expiry transactionally; TTL alone
cannot authorize acceptance. Telemetry uses bounded sampled slots, not an append-only audit.

Channel deletion tombstones; bounded manual purge is separate and Firestore does not
cascade. Direct Auth deletion preserves channel content and freezes missing-owner/payer
channels for verified recovery. See `docs/multi-account/operational-readiness.md` before
index deletion, data cleanup or recovery; preserve private backups for their retention window.
