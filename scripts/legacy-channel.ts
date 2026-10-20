import type { Firestore } from "firebase-admin/firestore";

// Identity, stats, auth tokens and service credentials are never snapshot fields.
export const LEGACY_FIELDS = ["userName", "channelId", "channelDescription", "userTitle", "niche", "targetAudience", "brandName", "website", "websiteContent", "competitors", "format"] as const;
export type LegacyMode = "audit" | "snapshot" | "restore";
const own = (data: Record<string, unknown>, key: string) => Object.prototype.hasOwnProperty.call(data, key);
export function legacyFields(data: Record<string, unknown>) {
  return Object.fromEntries(LEGACY_FIELDS.filter(key => own(data, key)).map(key => [key, data[key]]));
}

/** Non-destructive: existing snapshots and existing legacy fields always win. */
export function legacyPatch(data: Record<string, unknown>, mode: LegacyMode, now = new Date()) {
  const fields = legacyFields(data);
  if (mode === "audit") return {};
  if (mode === "snapshot") {
    if (own(data, "legacyChannelSnapshot") || !Object.keys(fields).length) return {};
    const snapshot = { version: 1, capturedAt: now.toISOString(), retainUntil: new Date(now.getTime() + 90 * 86400000).toISOString(), fields };
    // Duplicating an uncapped legacy scrape could exceed Firestore's 1 MiB limit.
    if (Buffer.byteLength(JSON.stringify({ ...data, legacyChannelSnapshot: snapshot }), "utf8") > 900_000) throw Error("Snapshot would exceed the conservative document size limit");
    return { legacyChannelSnapshot: snapshot };
  }
  const snapshot = data.legacyChannelSnapshot as { version?: number; fields?: Record<string, unknown> } | undefined;
  if (!snapshot || snapshot.version !== 1 || !snapshot.fields || typeof snapshot.fields !== "object") return {};
  return Object.fromEntries(Object.entries(legacyFields(snapshot.fields)).filter(([key]) => !own(data, key)));
}

export async function processLegacyUsers(db: Firestore, options: { mode: LegacyMode; apply?: boolean; limit?: number; after?: string }) {
  const limit = options.limit ?? 1000;
  if (!Number.isInteger(limit) || limit < 1 || limit > 10000) throw Error("limit must be 1..10000");
  const { FieldPath } = await import("firebase-admin/firestore");
  const report = { scanned: 0, withLegacyFields: 0, withSnapshot: 0, proposed: 0, written: 0, oversized: 0, nextCursor: options.after || null as string | null };
  while (report.scanned < limit) {
    const pageSize = Math.min(200, limit-report.scanned);
    let query = db.collection("users").orderBy(FieldPath.documentId()).limit(pageSize);
    if (report.nextCursor) query = query.startAfter(report.nextCursor);
    const page = await query.get();
    if (page.empty) break;
    for (const doc of page.docs) {
      const data = doc.data();
      report.scanned++;
      report.nextCursor = doc.id;
      if (Object.keys(legacyFields(data)).length) report.withLegacyFields++;
      if (own(data, "legacyChannelSnapshot")) report.withSnapshot++;
      let patch;
      try { patch = legacyPatch(data, options.mode); } catch { report.oversized++; continue; }
      if (!Object.keys(patch).length) continue;
      report.proposed++;
      if (options.apply) {
        // Re-read before writing: a concurrent run cannot replace the original snapshot.
        const written = await db.runTransaction(async tx => {
          const current = await tx.get(doc.ref);
          if (!current.exists) return false;
          const next = legacyPatch(current.data()!, options.mode);
          if (!Object.keys(next).length) return false;
          tx.update(doc.ref, next);
          return true;
        });
        if (written) report.written++;
      }
    }
    if (page.size < pageSize) break;
  }
  return report;
}
