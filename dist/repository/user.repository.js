import { db, firebase } from "../config/firebase.js";
import { extractTextFromHTML } from "../utlils/regex.js";
class UserRepository {
    constructor() {
        this.add = async (userId, data) => {
            try {
                if (!userId) {
                    throw new Error("userId is required");
                }
                await this.db
                    .collection(this.collection)
                    .doc(userId)
                    .set({
                    ...data,
                    createdAt: firebase.firestore.FieldValue.serverTimestamp(),
                    updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
                }, { merge: true });
            }
            catch (error) {
                console.log("error in add", error);
            }
        };
        this.update = async (userId, data) => {
            try {
                if (!userId) {
                    throw new Error("userId is required");
                }
                await this.db
                    .collection(this.collection)
                    .doc(userId)
                    .update({
                    ...data,
                    updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
                });
            }
            catch (error) {
                console.log("error", error);
            }
        };
        this.get = async (userId) => {
            try {
                const doc = await this.db.collection(this.collection).doc(userId).get();
                return doc.data();
            }
            catch (error) {
                console.log("error", error);
            }
        };
        this.getWebsiteContent = async (url) => {
            let html = "";
            try {
                const res = await fetch(url);
                if (res) {
                    html = await res?.text();
                    return extractTextFromHTML(html);
                }
            }
            catch (error) {
                console.log("error:  at getWebsiteContent", error);
            }
            return html;
        };
        this.db = db;
        this.collection = "users" /* COLLECTIONS.USERS */;
    }
}
export default UserRepository;
