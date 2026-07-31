import firebase from "firebase-admin";
// import serviceAccountJSON from "../../service.json";
const serviceAccountBase64 = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
if (!serviceAccountBase64) {
    throw new Error("FIREBASE_SERVICE_ACCOUNT_BASE64 environment variable is required");
}
const buff = Buffer.from(serviceAccountBase64, "base64");
const serviceAccount = JSON.parse(buff.toString("utf-8"));
firebase.initializeApp({
    credential: firebase.credential.cert(serviceAccount),
});
const db = firebase.firestore();
// Drop undefined values instead of throwing on write. Optional fields are
// pervasive here (onboarding/context enrichment, event metadata that carries
// one of several keys), and a partial update should simply skip absent fields
// rather than 500. Must be set before the client is first used.
db.settings({ ignoreUndefinedProperties: true });
const auth = firebase.auth();
export { db, firebase, auth };
