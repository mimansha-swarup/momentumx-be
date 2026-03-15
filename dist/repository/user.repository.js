import { db, firebase } from "../config/firebase.js";
class UserRepository {
    constructor() {
        this.add = async (userId, data) => {
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
        };
        this.update = async (userId, data) => {
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
        };
        this.get = async (userId) => {
            const doc = await this.db.collection(this.collection).doc(userId).get();
            return doc.data();
        };
        this.db = db;
        this.collection = "users" /* COLLECTIONS.USERS */;
    }
}
export default UserRepository;
