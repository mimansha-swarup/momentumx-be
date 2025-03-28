import { auth } from "firebase-functions/v1";
import { db, firebase } from "../config/firebase";
import { UserRecord } from "firebase-admin/auth";
import { COLLECTIONS } from "../constants/collection";

const getUserObject = (user: UserRecord) => {
  return {
    uid: user.uid,
    name: user.displayName || "Anonymous",
    email: user.email || "",
    photoURL: user.photoURL || "",
    createdAt: firebase.firestore.FieldValue.serverTimestamp(),
  };
};

export const onCreateUser = auth.user().onCreate((user) => {
  try {
    const userObject = getUserObject(user);
    db.collection(COLLECTIONS.USERS).doc(user.uid).set(userObject);
  } catch (error) {
    console.log("error", error);
  }
});
