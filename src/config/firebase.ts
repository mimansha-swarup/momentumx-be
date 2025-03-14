import firebase from "firebase-admin";

firebase.initializeApp({
  credential: firebase.credential.cert("path/to/serviceAccountKey.json"),
  databaseURL: "https://<DATABASE_NAME>.firebaseio.com",
});

const db = firebase.firestore();

export { db, firebase };
