/**
 * Phase 04 — backfill `accountId` onto every record written before Phase 03.
 *
 * Operational tooling, not app code. It touches Firestore directly rather than
 * going through a repository (backend-standards.md's rule): the repositories
 * exist to keep *request handling* off the database, and none of them can express
 * a documentId-paged full scan with a resumable cursor. Nothing in `src/` imports
 * this file.
 *
 * RUN ORDER
 *   1. gcloud firestore export ...            (phase doc, step 0 — do it first)
 *   2. node dist/scripts/backfill-account-id.js --dry-run
 *   3. node dist/scripts/backfill-account-id.js
 *   4. node dist/scripts/backfill-account-id.js --verify
 *
 * Phase 06 ships only when step 4 reports `mismatched === 0 && missing === 0`
 * for all five collections, and `orphaned` has a written triage decision.
 *
 * PRECONDITION, and it is not a formality: Phase 03 must be LIVE on all three
 * deploy artifacts (Vercel, Render, Cloud Functions), not merged. The SSE script
 * route is served only by Render, so a partial deploy leaves script documents
 * untagged — and this job is a single pass that will have scanned past them.
 */

import { FieldPath } from "firebase-admin/firestore";
import { db, firebase } from "../config/firebase.js";
import { COLLECTIONS } from "../constants/collection.js";

/**
 * Quarantine marker. A record whose owner cannot be resolved gets this rather
 * than a guess: `createdBy: ""` copied straight through would be a real value
 * shared by every such record across ALL users, merging unrelated people into one
 * fake account. That is the one genuinely destructive mistake available here.
 */
export const ORPHAN = "__orphan";

/**
 * `events` is excluded deliberately — it is append-only telemetry that nothing
 * reads (`event.repository.ts` exposes only `add()`), it is the largest
 * collection, and backfilling it buys nothing. New events carry `accountId` from
 * Phase 03; leave the history keyed by `createdBy`.
 */
export const BACKFILL_COLLECTIONS = [
  COLLECTIONS.IDEAS,
  COLLECTIONS.SCRIPTS,
  COLLECTIONS.HOOKS,
  COLLECTIONS.PACKAGING,
  COLLECTIONS.VIDEO_PROJECTS,
] as const;

const PAGE_SIZE = 500;

/**
 * uid → accountId, from `ownerUids`. Every account has exactly one owner at this
 * point; sharing does not exist until Phase 09.
 */
export const buildOwnerMap = (
  accounts: { id: string; ownerUids?: unknown }[]
): Map<string, string> => {
  const map = new Map<string, string>();
  for (const account of accounts) {
    if (!account?.id) continue;
    const owners = Array.isArray(account.ownerUids) ? account.ownerUids : [];
    for (const uid of owners) {
      // First writer wins. A uid owning two accounts means Phase 03's claim
      // transaction was bypassed; the verify pass will surface it as mismatched
      // rather than this silently picking the newer one.
      if (typeof uid === "string" && uid && !map.has(uid)) map.set(uid, account.id);
    }
  }
  return map;
};

/**
 * The owner decision for one document. Returns a non-empty string ALWAYS.
 *
 * Never returning `undefined` is the point. `src/config/firebase.ts` sets
 * `ignoreUndefinedProperties: true`, so `set({ accountId: undefined }, { merge })`
 * writes *nothing* and reports success — the document stays untagged, the
 * `patched` counter still increments, and it goes invisible to its owner the
 * moment Phase 06 flips reads. Indistinguishable from data loss.
 *
 * So the type is tested, not truthiness, and both failure modes land on ORPHAN:
 * an absent `createdBy`, and one that maps to no account.
 */
export const resolveAccountId = (
  owner: unknown,
  ownerToAccount: Map<string, string>
): string => {
  if (typeof owner !== "string" || owner.length === 0) return ORPHAN;
  return ownerToAccount.get(owner) ?? ORPHAN;
};

/** Verdict for one document in the verification pass. */
export const verifyDoc = (
  data: { createdBy?: unknown; accountId?: unknown },
  ownerToAccount: Map<string, string>
): "matched" | "mismatched" | "orphaned" | "missing" => {
  const actual = data.accountId;
  if (typeof actual !== "string" || actual.length === 0) return "missing";
  if (actual === ORPHAN) return "orphaned";
  // Field-present is not field-correct. Every realistic backfill bug — a shared
  // cursor, a mis-scoped loop variable, a copy-paste that pages one collection
  // while writing to another — produces a document whose accountId is present
  // and WRONG, which is the data-mixing outcome this whole plan exists to
  // prevent and which a presence check sails straight past.
  return actual === resolveAccountId(data.createdBy, ownerToAccount)
    ? "matched"
    : "mismatched";
};

const progressRef = (collection: string) =>
  db.collection(COLLECTIONS.MIGRATIONS).doc(collection);

type Counts = {
  scanned: number;
  patched: number;
  orphaned: number;
  skipped: number;
  failed: number;
};

/**
 * One collection, paged by document id.
 *
 * Never `offset()`: Firestore bills reads for the documents an offset skips, so
 * that costs more the further in you get. `startAfter(lastId)` costs nothing.
 */
export const backfillCollection = async (
  collection: string,
  ownerToAccount: Map<string, string>,
  { dryRun = false, resume = true }: { dryRun?: boolean; resume?: boolean } = {}
): Promise<Counts> => {
  const ref = progressRef(collection);
  const counts: Counts = { scanned: 0, patched: 0, orphaned: 0, skipped: 0, failed: 0 };

  let cursor: string | undefined;
  if (resume && !dryRun) {
    const prior = await ref.get();
    const last = prior.get("lastCursor");
    if (typeof last === "string" && last) cursor = last;
  }

  if (!dryRun) {
    await ref.set(
      { startedAt: firebase.firestore.FieldValue.serverTimestamp(), completedAt: null },
      { merge: true }
    );
  }

  const writer = dryRun ? null : db.bulkWriter();

  // `patched` counts writes ATTEMPTED, which is what the loop below can know. So
  // without this the summary reports a clean run while writes were failing, and
  // the individual `set()` promises — discarded, since the loop does not await
  // them — reject unhandled, which on Node 18+ takes the process down mid-scan.
  // `--verify` is still the real gate; this is what makes the failure legible
  // when someone reads the log instead of running step 4.
  //
  // Installing a handler REPLACES BulkWriter's own, so this one has to reproduce
  // its policy rather than invent a friendlier-looking one: retry only the two
  // transient codes, and keep the full ten attempts. A generic
  // `failedAttempts < 3` reads like a safe default and is worse in both
  // directions — it burns attempts on permanent errors like PERMISSION_DENIED,
  // and it gives up on a passing UNAVAILABLE blip that the default would have
  // ridden out, on a one-shot job over records that have no other copy.
  const RETRYABLE = new Set([10 /* ABORTED */, 14 /* UNAVAILABLE */]);
  const MAX_ATTEMPTS = 10;
  writer?.onWriteError((error) => {
    if (RETRYABLE.has(error.code) && error.failedAttempts < MAX_ATTEMPTS) return true;
    counts.failed++;
    console.error(
      JSON.stringify({
        event: "backfill_write_failed",
        path: error.documentRef.path,
        code: error.code,
        attempts: error.failedAttempts,
      })
    );
    return false;
  });

  for (;;) {
    let query = db
      .collection(collection)
      .orderBy(FieldPath.documentId())
      .limit(PAGE_SIZE);
    if (cursor) query = query.startAfter(cursor);

    const snap = await query.get();
    if (snap.empty) break;

    for (const doc of snap.docs) {
      counts.scanned++;
      // What makes the job re-runnable. Firestore has no "field is missing"
      // filter, so this is a full scan with an in-memory skip — being
      // interruptible is not optional.
      if (doc.get("accountId")) {
        counts.skipped++;
        continue;
      }

      const accountId = resolveAccountId(doc.get("createdBy"), ownerToAccount);
      if (accountId === ORPHAN) {
        counts.orphaned++;
        console.warn(
          JSON.stringify({
            event: "backfill_orphan",
            path: doc.ref.path,
            owner: doc.get("createdBy") ?? null,
          })
        );
      }

      counts.patched++;
      // Swallowed here only because onWriteError above has already counted and
      // logged it; an uncaught rejection would kill the run instead.
      void writer?.set(doc.ref, { accountId }, { merge: true }).catch(() => undefined);
    }

    cursor = snap.docs[snap.docs.length - 1].id;
    // BEFORE the cursor, always. `set()` only enqueues — BulkWriter batches, rate
    // limits and retries on its own schedule — so storing `lastCursor` for a page
    // whose writes are still in flight makes the cursor claim durability the data
    // does not have. Kill the process there and `--verify` reports those documents
    // `missing`, while the obvious repair (re-run the job) resumes PAST them and
    // fixes nothing; you would have to know to clear `lastCursor` by hand. `flush`
    // waits for previously-issued writes, retries included, and never rejects —
    // the per-write promises carry the errors, and `onWriteError` above has
    // already counted them.
    await writer?.flush();
    if (!dryRun) await ref.set({ lastCursor: cursor, ...counts }, { merge: true });
    if (snap.size < PAGE_SIZE) break;
  }

  await writer?.close();
  if (!dryRun) {
    await ref.set(
      { ...counts, completedAt: firebase.firestore.FieldValue.serverTimestamp() },
      { merge: true }
    );
  }

  console.log(JSON.stringify({ event: "backfill_done", collection, dryRun, ...counts }));
  return counts;
};

type Verdicts = {
  scanned: number;
  matched: number;
  mismatched: number;
  orphaned: number;
  missing: number;
};

/** The same scan, asserting the invariant rather than the field's presence. */
export const verifyCollection = async (
  collection: string,
  ownerToAccount: Map<string, string>
): Promise<Verdicts> => {
  const v: Verdicts = { scanned: 0, matched: 0, mismatched: 0, orphaned: 0, missing: 0 };

  let cursor: string | undefined;
  for (;;) {
    let query = db
      .collection(collection)
      .orderBy(FieldPath.documentId())
      .limit(PAGE_SIZE);
    if (cursor) query = query.startAfter(cursor);

    const snap = await query.get();
    if (snap.empty) break;

    for (const doc of snap.docs) {
      v.scanned++;
      const verdict = verifyDoc(
        { createdBy: doc.get("createdBy"), accountId: doc.get("accountId") },
        ownerToAccount
      );
      v[verdict]++;
      if (verdict === "mismatched" || verdict === "missing") {
        console.error(
          JSON.stringify({ event: `backfill_${verdict}`, path: doc.ref.path })
        );
      }
    }

    cursor = snap.docs[snap.docs.length - 1].id;
    if (snap.size < PAGE_SIZE) break;
  }

  await progressRef(collection).set(
    { verify: { ...v, completedAt: firebase.firestore.FieldValue.serverTimestamp() } },
    { merge: true }
  );

  console.log(JSON.stringify({ event: "verify_done", collection, ...v }));
  return v;
};

export const loadOwnerMap = async (): Promise<Map<string, string>> => {
  const snap = await db.collection(COLLECTIONS.ACCOUNTS).get();
  return buildOwnerMap(
    snap.docs.map((d) => ({ id: d.id, ownerUids: d.get("ownerUids") }))
  );
};

/**
 * `--collection=` must name one of the five, and the check is not pedantry.
 *
 * The value went straight to `db.collection(...)`, so a typo or a plausible
 * guess pointed the scan at a collection that has no `createdBy` — `users` being
 * the obvious one — where every document resolves to ORPHAN and the job writes
 * `accountId: "__orphan"` across all of them. This is a script run by hand,
 * against production, usually at the worst possible hour.
 */
export const pickCollections = (only?: string): string[] => {
  const all = BACKFILL_COLLECTIONS as readonly string[];
  if (!only) return all.slice();
  if (!all.includes(only)) {
    throw new Error(`--collection must be one of: ${all.join(", ")}`);
  }
  return [only];
};

const main = async () => {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const verify = args.includes("--verify");
  const only = args.find((a) => a.startsWith("--collection="))?.split("=")[1];
  const collections = pickCollections(only);

  const ownerToAccount = await loadOwnerMap();
  console.log(JSON.stringify({ event: "owner_map", owners: ownerToAccount.size }));
  if (ownerToAccount.size === 0) {
    // Every document would quarantine as an orphan and the run would look like it
    // "worked". Phase 03 mints accounts lazily, so an empty map most likely means
    // it is not actually deployed yet.
    throw new Error("owner map is empty — is Phase 03 deployed and has any user signed in?");
  }

  let failed = false;
  for (const collection of collections) {
    if (verify) {
      const v = await verifyCollection(collection, ownerToAccount);
      if (v.mismatched > 0 || v.missing > 0) failed = true;
    } else {
      const counts = await backfillCollection(collection, ownerToAccount, { dryRun });
      // A non-zero exit, so a partially-written collection cannot be mistaken for
      // a finished one by whoever is watching the terminal.
      if (counts.failed > 0) failed = true;
    }
  }

  if (failed) throw new Error("run failed — see backfill_write_failed/backfill_mismatched/backfill_missing above");
};

// Only when executed directly, so the exported helpers stay importable by tests.
if (process.argv[1] && process.argv[1].includes("backfill-account-id")) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
