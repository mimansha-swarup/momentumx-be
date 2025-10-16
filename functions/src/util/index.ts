import {firestore} from 'firebase-admin';
import { UserRecord } from 'firebase-admin/auth';
export const getUserObject = (user: UserRecord) => {
  return {
    uid: user.uid,
    name: user.displayName || "Anonymous",
    email: user.email || "",
    photoURL: user.photoURL || "",
    createdAt: firestore.FieldValue.serverTimestamp(),
    
  };
};
export const enum COLLECTIONS {
  USERS = "users",
  SCRIPTS = "scripts",
  TOPICS = "topics",
}
