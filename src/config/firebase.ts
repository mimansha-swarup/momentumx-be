import firebase from "firebase-admin";
// import serviceAccountJSON from "../../service.json";

const serviceAccountBase64 = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
if (!serviceAccountBase64) {
  throw new Error("FIREBASE_SERVICE_ACCOUNT_BASE64 environment variable is required");
}
const buff = Buffer.from(serviceAccountBase64, "base64");
const serviceAccount: firebase.ServiceAccount = JSON.parse(buff.toString("utf-8"));
firebase.initializeApp({
  credential: firebase.credential.cert(serviceAccount),
});

const db = firebase.firestore();

const auth = firebase.auth();

export { db, firebase, auth };
