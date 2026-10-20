---
name: firestore-operations
description: Reference for Firestore repository patterns in MomentumX — imports, CRUD, batch writes, queries, timestamps, IDs, and current document shapes. Use when building or modifying repository layer code.
---

# Firestore Operations Reference

Read `.claude/rules/firestore-conventions.md` before repository changes. Current shapes
live in `src/types/routes/`, names in `src/constants/collection.ts`, and working examples
in the corresponding repository. Do not copy an old schema inventory into new code.

- Import `{ db, firebase }` from `src/config/firebase.ts`; use `COLLECTIONS` and
  `SUBCOLLECTIONS` rather than inventing path strings.
- Channel content is scoped by `accountId`; `createdBy` records authorship only.
  Pass authenticated `RecordOwner` context built by `ownerOf(req)`, never client identity.
- Bound list queries and validate document IDs. Loaded resources and their linked resources
  must belong to the active channel. Preserve `wrong_account` versus `account_forbidden`
  handling through the shared authorization helper.
- Use server timestamps for stored lifecycle times. UUIDs identify ideas/scripts;
  user documents use Auth UIDs; packaging uses the project ID, never an auto-ID.
- Use atomic batches for independent multi-document writes; use transactions for
  read/check/write invariants. Paid generation delivery must use the existing reservation,
  artifact and accounting transaction, not a standalone batch followed by billing.
- Account deletion tombstones first; bounded manual purge is separate. Do not assume
  Firestore cascades deletion. Preserve orphan recovery and membership invariants.
- Billing, invitations and channel usage are active functionality. Telemetry uses bounded
  sampled slots rather than an append-only audit log.

See `docs/multi-account/README.md` for tenancy, allowance and recovery behavior and
`docs/multi-account/operational-readiness.md` for index and maintenance checks.
