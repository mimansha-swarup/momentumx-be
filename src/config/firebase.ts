import firebase from "firebase-admin";
// import serviceAccountJSON from "../../service.json";

let serviceAccount: firebase.ServiceAccount;
// if (process.env.FIREBASE_SERVICE_ACCOUNT_BASE64) {
  const buff = Buffer.from(
    process.env.FIREBASE_SERVICE_ACCOUNT_BASE64,
    "base64"
  );
  serviceAccount = JSON.parse(buff.toString("utf-8"));
// } else {
//   serviceAccount = serviceAccountJSON as firebase.ServiceAccount;
// }
firebase.initializeApp({
  credential: firebase.credential.cert(serviceAccount),
});

const db = firebase.firestore();

const auth = firebase.auth();

export { db, firebase, auth };
