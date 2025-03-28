import firebase from "firebase-admin";
import serviceAccount from "../../service.json";
firebase.initializeApp({
  credential: firebase.credential.cert(serviceAccount),
  // databaseURL: "https://<DATABASE_NAME>.firebaseio.com",
});

const db = firebase.firestore();

const auth = firebase.auth();

export { db, firebase, auth };
