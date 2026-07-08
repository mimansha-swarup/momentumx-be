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
    stats: { topics: 0, scripts: 0, credits: 0 },
  };
};
export const enum COLLECTIONS {
  USERS = "users",
  SCRIPTS = "scripts",
  TOPICS = "topics",
  PACKAGING = "packaging",
  VIDEO_PROJECTS = "videoProjects",
  HOOKS = "hooks",
}
