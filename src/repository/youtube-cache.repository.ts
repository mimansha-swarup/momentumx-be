import { createHash } from "node:crypto";
import { db } from "../config/firebase.js";
import { COLLECTIONS } from "../constants/collection.js";
const TTL_MS = 6 * 60 * 60 * 1000;
const MAX_ENTRIES = 256;
const cache = new Map<string, { expiresAt: number; value: Promise<unknown> }>();

// A cache outage must not hold research hostage. The underlying cache RPC can
// finish later; no authoritative application data depends on its result.
async function optionalCache<T>(operation: Promise<T>): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation.catch(() => undefined),
      new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), 1_000); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// Public YouTube data only. Local promises coalesce concurrent requests; 256
// shared Firestore slots survive cold starts. Hash collisions replace a slot,
// never serve another query's data. Expiry is checked on read, no scheduler/TTL.
// ponytail: direct-mapped bounded cache; add slots if measured hit rate needs it.
export const youtubeJson = async <T>(url: string): Promise<T> => {
  const hit = cache.get(url);
  if (hit && hit.expiresAt > Date.now()) return hit.value as Promise<T>;
  cache.delete(url);
  if (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value!);
  const entry = { expiresAt: Date.now() + TTL_MS, value: Promise.resolve(undefined) as Promise<unknown> };
  const value = (async () => {
    const publicUrl = new URL(url);
    publicUrl.searchParams.delete("key");
    publicUrl.searchParams.sort();
    const key = createHash("sha256").update(publicUrl.toString()).digest("hex");
    const ref = db.collection(COLLECTIONS.YOUTUBE_CACHE).doc(key.slice(0, 2));
    const stored = await optionalCache(ref.get().then(doc => doc.data()));
    if (stored?.key === key && stored.expiresAt > Date.now()) {
      entry.expiresAt = stored.expiresAt;
      return stored.data;
    }
    const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (response.ok === false) throw new Error("YouTube API unavailable");
    const data = await response.json();
    entry.expiresAt = Date.now() + TTL_MS;
    await optionalCache(ref.set({ key, expiresAt: entry.expiresAt, data }));
    return data;
  })();
  entry.value = value;
  cache.set(url, entry);
  try { return await value as T; }
  catch (error) {
    if (cache.get(url) === entry) cache.delete(url);
    throw error;
  }
};
