import {firestore} from 'firebase-admin';
import { UserRecord } from 'firebase-admin/auth';
export const getUserObject = (user: UserRecord) => {
  return {
    uid: user.uid,
    name: user.displayName || "Anonymous",
    email: user.email || "",
    photoURL: user.photoURL || "",
    createdAt: firestore.FieldValue.serverTimestamp(),
    // Seed lifetime counters at creation so every user has a `stats` baseline —
    // including those who sign up but never finish onboarding. Mirrors the
    // `stats` shape in the API's src/constants/collection.ts.
    stats: { ideas: 0, scripts: 0, credits: 0 },
  };
};
/**
 * A SECOND COPY of the API's enum, because `functions/` is a separate build with
 * its own package.json and tsconfig and cannot import from `src/`.
 *
 * The canonical list is `src/constants/collection.ts`. This copy had already
 * drifted — it was missing `EVENTS` — which was harmless only because Functions
 * writes exactly one collection (`users`, from the onCreate trigger). Keep the
 * two in step anyway: the day something here writes a second collection, a
 * missing name becomes a hardcoded string.
 *
 * The multi-account names (accounts/billing/invites/migrations) are deliberately
 * NOT copied down. Nothing in `functions/` writes them, and mirroring names on
 * spec is how the drift started.
 */
export const enum COLLECTIONS {
  USERS = "users",
  SCRIPTS = "scripts",
  IDEAS = "ideas",
  PACKAGING = "packaging",
  VIDEO_PROJECTS = "videoProjects",
  HOOKS = "hooks",
  EVENTS = "events",
}
