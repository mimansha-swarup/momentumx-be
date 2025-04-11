import { user } from "firebase-functions/v1/auth";
import { UserRecord } from "firebase-admin/auth";
import { COLLECTIONS, getUserObject } from "./util";
import * as admin from "firebase-admin";

admin.initializeApp();

export const onCreateUser = user().onCreate((user: UserRecord) => {
  try {
    const userObject = getUserObject(user);

    admin
      .firestore()
      .collection(COLLECTIONS.USERS)
      .doc(user.uid)
      .set(userObject);
  } catch (error) {
    console.log("error", error);
  }
});
