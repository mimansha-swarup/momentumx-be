/**
 * Phase 05a — re-key auto-ID packaging documents onto their `videoProjectId`.
 *
 * Operational tooling, like `backfill-account-id.ts`. Nothing in `src/` imports it.
 *
 * RUN ORDER
 *   1. gcloud firestore export ...                        (same backup as Phase 04)
 *   2. node dist/scripts/rekey-packaging.js --dry-run
 *   3. node dist/scripts/rekey-packaging.js
 *   4. Read `migrations/packaging-rekey`; collisions must be zero or triaged.
 *   5. ONLY THEN: the delete commit — remove `findByVideoProject` and the
 *      fallback in `PackagingService.locateForProject`.
 *
 * THE OLD DOCUMENT IS NEVER DELETED HERE. It is marked `supersededBy` and left in
 * place, because that is the entire rollback path: repoint
 * `videoProjects.packagingId` back at it and the previous state is restored
 * exactly. Deleting is a separate, later, deliberate commit.
 *
 * The merge is the whole risk. A project can have BOTH a legacy save document and
 * a persist-on-generate document keyed on the project id — `upsertGeneratedItem`
 * has always used the deterministic key while the save path minted auto-IDs. For
 * those, "just re-key it" silently drops whichever side loses.
 */

import { FieldPath } from "firebase-admin/firestore";
import { db, firebase } from "../config/firebase.js";
import { COLLECTIONS } from "../constants/collection.js";

const PAGE_SIZE = 500;
const PROGRESS_DOC = "packaging-rekey";

/** Content fields, plus the state that rides with them. */
const MERGEABLE = [
  "titles",
  "description",
  "thumbnail",
  "shorts",
  "selectedTitleIndex",
  "selectedThumbnailIndex",
  "itemStatuses",
  "isStale",
  "staleReason",
  "staleSince",
  "createdBy",
  "accountId",
  "videoProjectId",
] as const;

const millis = (value: unknown): number => {
  if (!value) return 0;
  if (typeof value === "number") return value;
  if (typeof (value as { toMillis?: () => number })?.toMillis === "function") {
    return (value as { toMillis: () => number }).toMillis();
  }
  const parsed = Date.parse(String(value));
  return Number.isNaN(parsed) ? 0 : parsed;
};

/**
 * Field-by-field merge, newer `updatedAt` winning, with every contested field
 * reported.
 *
 * Overwriting instead of merging is the mistake this phase is named after: the
 * legacy document holds the user's edited title and description, the deterministic
 * one holds generated shorts and thumbnail, and whichever is written last erases
 * the other half of a package the user considers finished.
 *
 * A field present on only one side is not a collision — it is just data, and it is
 * taken. A collision is both sides holding DIFFERENT non-empty values.
 */
export const mergePackaging = (
  legacy: Record<string, unknown>,
  target: Record<string, unknown> | null
): { merged: Record<string, unknown>; collisions: string[] } => {
  if (!target) return { merged: { ...legacy }, collisions: [] };

  const legacyNewer = millis(legacy.updatedAt) > millis(target.updatedAt);
  const merged: Record<string, unknown> = { ...target };
  const collisions: string[] = [];

  // The two timestamps are resolved here rather than in the loop below, because
  // neither one is a collision and both have a right answer that "newer
  // updatedAt wins" gets wrong.
  //
  // `createdAt` was in MERGEABLE, and both documents ALWAYS have one — the
  // generate path stamps it (packaging.repository.ts) and so does the save path
  // (packaging.service.ts) — and they were written at different moments, so they
  // always differ. Every merged pair therefore reported a `createdAt` collision,
  // the script exited 2, and the phase's own gate ("collisions must be zero or
  // triaged") could never clear. The older stamp is the true creation time.
  const created = [legacy.createdAt, target.createdAt].filter(Boolean);
  if (created.length > 0) {
    merged.createdAt = created.sort((a, b) => millis(a) - millis(b))[0];
  }
  // And keep the later `updatedAt`, so a document that just absorbed the newer
  // half does not claim to be older than the content it now holds.
  if (legacyNewer) merged.updatedAt = legacy.updatedAt;

  // Mirrors `PackagingService.isEmptyField`, INCLUDING its shorts case — that is
  // the one field whose empty value is an object, and an object is not caught by
  // any of the generic checks.
  //
  // `upsertGeneratedItem` scaffolds a new document with
  // `shorts: { segments: [], totalDuration: "" }`, so generating a *title* leaves
  // an empty shorts object on the deterministic document. Without this case that
  // scaffold counts as a value: it collides with the legacy document's real
  // Shorts script and, whenever the scaffold is the newer of the two, wins — and
  // the user's Shorts script is gone. Every other empty the scaffold writes
  // (`titles: []`, `description: ""`, `thumbnail: []`) is already covered, which
  // is what makes this one easy to miss.
  const empty = (v: unknown) =>
    v === undefined ||
    v === null ||
    v === "" ||
    (Array.isArray(v) && v.length === 0) ||
    (typeof v === "object" &&
      Array.isArray((v as { segments?: unknown[] }).segments) &&
      (v as { segments: unknown[] }).segments.length === 0);

  for (const field of MERGEABLE) {
    const a = legacy[field];
    const b = target[field];

    if (empty(a)) continue;
    if (empty(b)) {
      merged[field] = a;
      continue;
    }
    if (JSON.stringify(a) === JSON.stringify(b)) continue;

    collisions.push(field);
    if (legacyNewer) merged[field] = a;
  }

  // `itemStatuses` stays in the loop above so a difference is still REPORTED, but
  // its value is decided here, because resolving a map wholesale by recency is
  // wrong in a way the loop cannot express. The scaffold carries
  // `description: "not_started"` while the legacy document carries
  // `description: "completed"`, so a merely-newer scaffold stamps "not_started"
  // over an item whose content this very merge just carried across. The UI then
  // shows a generated description as missing and the user regenerates over their
  // own work — the loss arrives later, by their own hand, which is the hardest
  // kind to trace back to a migration. Per item, anything beats "not_started".
  const statusesOf = (d: Record<string, unknown>) =>
    (d.itemStatuses ?? {}) as Record<string, unknown>;
  const items = { ...statusesOf(target), ...statusesOf(legacy) };
  for (const item of Object.keys(items)) {
    const [first, second] = legacyNewer
      ? [statusesOf(legacy)[item], statusesOf(target)[item]]
      : [statusesOf(target)[item], statusesOf(legacy)[item]];
    items[item] = first && first !== "not_started" ? first : (second ?? first);
  }
  if (Object.keys(items).length > 0) merged.itemStatuses = items;

  return { merged, collisions };
};

type Counts = {
  scanned: number;
  rekeyed: number;
  merged: number;
  collisions: number;
  alreadyKeyed: number;
  skipped: number;
};

export const rekeyPackaging = async ({ dryRun = false } = {}): Promise<Counts> => {
  const counts: Counts = {
    scanned: 0,
    rekeyed: 0,
    merged: 0,
    collisions: 0,
    alreadyKeyed: 0,
    skipped: 0,
  };
  const progress = db.collection(COLLECTIONS.MIGRATIONS).doc(PROGRESS_DOC);
  let cursor: string | undefined;

  for (;;) {
    let query = db
      .collection(COLLECTIONS.PACKAGING)
      .orderBy(FieldPath.documentId())
      .limit(PAGE_SIZE);
    if (cursor) query = query.startAfter(cursor);

    const snap = await query.get();
    if (snap.empty) break;

    for (const doc of snap.docs) {
      counts.scanned++;
      const data = doc.data() ?? {};
      const projectId = data.videoProjectId;

      if (doc.id === projectId) {
        counts.alreadyKeyed++;
        continue;
      }
      if (typeof projectId !== "string" || !projectId) {
        // Nothing to key it on. Never guess an id — leave it and report it.
        counts.skipped++;
        console.warn(
          JSON.stringify({ event: "rekey_no_project", path: doc.ref.path })
        );
        continue;
      }
      if (data.supersededBy) {
        counts.skipped++; // already migrated by an earlier run
        continue;
      }

      const targetRef = db.collection(COLLECTIONS.PACKAGING).doc(projectId);
      const targetSnap = await targetRef.get();
      const target = targetSnap.exists
        ? (targetSnap.data() as Record<string, unknown>)
        : null;

      const { merged, collisions } = mergePackaging(data, target);
      if (target) counts.merged++;
      if (collisions.length > 0) {
        counts.collisions++;
        console.warn(
          JSON.stringify({
            event: "rekey_collision",
            legacyId: doc.id,
            projectId,
            fields: collisions,
            resolvedFrom: millis(data.updatedAt) > millis(target?.updatedAt)
              ? "legacy"
              : "deterministic",
          })
        );
      }

      counts.rekeyed++;
      if (dryRun) continue;

      const batch = db.batch();
      batch.set(targetRef, { ...merged, id: projectId }, { merge: true });
      batch.set(
        db.collection(COLLECTIONS.VIDEO_PROJECTS).doc(projectId),
        { packagingId: projectId },
        { merge: true }
      );
      // Tombstone, not a delete. This is the rollback.
      batch.set(doc.ref, { supersededBy: projectId }, { merge: true });
      await batch.commit();
    }

    cursor = snap.docs[snap.docs.length - 1].id;
    // Counts only. This used to also write `lastCursor`, which nothing ever read
    // — unlike `backfill-account-id.ts`, this job restarts from the beginning
    // every time, and the stored cursor implied a resume that did not exist.
    // Restarting is safe rather than merely tolerable: an already-keyed document
    // is counted `alreadyKeyed` and a tombstoned one is `skipped`, so a rerun
    // only costs reads.
    if (!dryRun) await progress.set({ ...counts }, { merge: true });
    if (snap.size < PAGE_SIZE) break;
  }

  if (!dryRun) {
    await progress.set(
      { ...counts, completedAt: firebase.firestore.FieldValue.serverTimestamp() },
      { merge: true }
    );
  }
  console.log(JSON.stringify({ event: "rekey_done", dryRun, ...counts }));
  return counts;
};

if (process.argv[1] && process.argv[1].includes("rekey-packaging")) {
  rekeyPackaging({ dryRun: process.argv.includes("--dry-run") })
    .then((c) => process.exit(c.collisions > 0 ? 2 : 0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
