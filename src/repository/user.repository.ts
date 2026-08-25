import { Firestore } from "firebase-admin/firestore";
import { db, firebase } from "../config/firebase.js";
import { COLLECTIONS } from "../constants/collection.js";

// Turns `{"stats.ideas": v}` into `{stats: {ideas: v}}` so a dotted key keeps
// meaning "nested path" under `set(..., { merge: true })`, which otherwise reads
// it as a literal field name. Merge semantics then leave sibling fields (and
// sibling counters) untouched, and FieldValue sentinels work unchanged at any
// depth. Keys without a dot pass through as-is.
export function expandFieldPaths(
  data: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (!key.includes(".")) {
      out[key] = value;
      continue;
    }
    const segments = key.split(".");
    let cursor = out;
    for (let i = 0; i < segments.length - 1; i++) {
      const segment = segments[i];
      // Only descend into a plain object we created; never merge into a
      // FieldValue sentinel or overwrite a non-object already placed here.
      if (typeof cursor[segment] !== "object" || cursor[segment] === null) {
        cursor[segment] = {};
      }
      cursor = cursor[segment] as Record<string, unknown>;
    }
    cursor[segments[segments.length - 1]] = value;
  }
  return out;
}

class UserRepository {
  private db: Firestore;
  private collection: `${COLLECTIONS}`;

  constructor() {
    this.db = db;
    this.collection = COLLECTIONS.USERS;
  }

  add = async (userId: string, data: unknown) => {
    if (!userId) {
      throw new Error("userId is required");
    }
    await this.db
      .collection(this.collection)
      .doc(userId)
      .set(
        {
          ...(data as Record<string, unknown>),
          createdAt: firebase.firestore.FieldValue.serverTimestamp(),
          updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
  };

  // Phase 01 item 2. `.update()` THROWS when the document doesn't exist, so a
  // counter increment on a user whose record never landed (the auth trigger used
  // to drop its write) failed the whole request. `set(..., { merge: true })`
  // creates a minimal record instead, which makes a missing profile self-healing
  // — and that matters more once Phase 08 gates generation on a balance the user
  // cannot create for themselves.
  //
  // The catch: `update()` interprets a dotted key as a PATH, while `set()` treats
  // it as a literal field name. Swapping them naively would turn
  // `{"stats.ideas": increment(1)}` into a top-level field called "stats.ideas"
  // and silently orphan the real counter. All three counter writes use that form
  // (`content.service.ts:186, 360, 477`), so expand the paths first.
  update = async (userId: string, data: unknown) => {
    if (!userId) {
      throw new Error("userId is required");
    }
    await this.db
      .collection(this.collection)
      .doc(userId)
      .set(
        expandFieldPaths({
          ...(data as Record<string, unknown>),
          updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
        }),
        { merge: true }
      );
  };

  get = async (userId: string) => {
    const doc = await this.db.collection(this.collection).doc(userId).get();
    return doc.data();
  };

}

export default UserRepository;
