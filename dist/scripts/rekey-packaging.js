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
    "createdAt",
];
const millis = (value) => {
    if (!value)
        return 0;
    if (typeof value === "number")
        return value;
    if (typeof value?.toMillis === "function") {
        return value.toMillis();
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
export const mergePackaging = (legacy, target) => {
    if (!target)
        return { merged: { ...legacy }, collisions: [] };
    const legacyNewer = millis(legacy.updatedAt) > millis(target.updatedAt);
    const merged = { ...target };
    const collisions = [];
    const empty = (v) => v === undefined ||
        v === null ||
        v === "" ||
        (Array.isArray(v) && v.length === 0);
    for (const field of MERGEABLE) {
        const a = legacy[field];
        const b = target[field];
        if (empty(a))
            continue;
        if (empty(b)) {
            merged[field] = a;
            continue;
        }
        if (JSON.stringify(a) === JSON.stringify(b))
            continue;
        collisions.push(field);
        if (legacyNewer)
            merged[field] = a;
    }
    return { merged, collisions };
};
export const rekeyPackaging = async ({ dryRun = false } = {}) => {
    const counts = {
        scanned: 0,
        rekeyed: 0,
        merged: 0,
        collisions: 0,
        alreadyKeyed: 0,
        skipped: 0,
    };
    const progress = db.collection("migrations" /* COLLECTIONS.MIGRATIONS */).doc(PROGRESS_DOC);
    let cursor;
    for (;;) {
        let query = db
            .collection("packaging" /* COLLECTIONS.PACKAGING */)
            .orderBy(FieldPath.documentId())
            .limit(PAGE_SIZE);
        if (cursor)
            query = query.startAfter(cursor);
        const snap = await query.get();
        if (snap.empty)
            break;
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
                console.warn(JSON.stringify({ event: "rekey_no_project", path: doc.ref.path }));
                continue;
            }
            if (data.supersededBy) {
                counts.skipped++; // already migrated by an earlier run
                continue;
            }
            const targetRef = db.collection("packaging" /* COLLECTIONS.PACKAGING */).doc(projectId);
            const targetSnap = await targetRef.get();
            const target = targetSnap.exists
                ? targetSnap.data()
                : null;
            const { merged, collisions } = mergePackaging(data, target);
            if (target)
                counts.merged++;
            if (collisions.length > 0) {
                counts.collisions++;
                console.warn(JSON.stringify({
                    event: "rekey_collision",
                    legacyId: doc.id,
                    projectId,
                    fields: collisions,
                    resolvedFrom: millis(data.updatedAt) > millis(target?.updatedAt)
                        ? "legacy"
                        : "deterministic",
                }));
            }
            counts.rekeyed++;
            if (dryRun)
                continue;
            const batch = db.batch();
            batch.set(targetRef, { ...merged, id: projectId }, { merge: true });
            batch.set(db.collection("videoProjects" /* COLLECTIONS.VIDEO_PROJECTS */).doc(projectId), { packagingId: projectId }, { merge: true });
            // Tombstone, not a delete. This is the rollback.
            batch.set(doc.ref, { supersededBy: projectId }, { merge: true });
            await batch.commit();
        }
        cursor = snap.docs[snap.docs.length - 1].id;
        if (!dryRun)
            await progress.set({ lastCursor: cursor, ...counts }, { merge: true });
        if (snap.size < PAGE_SIZE)
            break;
    }
    if (!dryRun) {
        await progress.set({ ...counts, completedAt: firebase.firestore.FieldValue.serverTimestamp() }, { merge: true });
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
