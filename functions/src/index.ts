import { user } from "firebase-functions/v1/auth";
import { UserRecord } from "firebase-admin/auth";
import { COLLECTIONS, getUserObject } from "./util";
import * as admin from "firebase-admin";

admin.initializeApp();

// Phase 01 item 2. Three things were wrong here and only one of them was visible:
//
// 1. The write was never returned or awaited. In a background Cloud Function the
//    instance can be frozen the moment the handler returns, so pending work is
//    dropped — the record sometimes simply never landed. The surrounding
//    try/catch could not help either, because it never held the promise.
// 2. `.set(data)` without merge would clobber a record the API had already
//    created (onboarding can complete before this trigger runs).
// 3. Failures were swallowed by `console.log`, so a user with no profile record
//    looked identical to a healthy one.
//
// Throwing marks the invocation failed and surfaces it in error reporting. It
// does not undo the auth user, which is why `UserRepository` must also self-heal
// (same item) rather than assuming this always succeeded.
export const onCreateUser = user().onCreate(async (user: UserRecord) => {
  try {
    await admin
      .firestore()
      .collection(COLLECTIONS.USERS)
      .doc(user.uid)
      .set(getUserObject(user), { merge: true });
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "user_record_create_failed",
        uid: user.uid,
        message: (error as Error)?.message,
      })
    );
    throw error;
  }
});
