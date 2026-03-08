import { db, firebase } from "../config/firebase.js";
class HooksRepository {
    constructor() {
        this.save = async (data) => {
            const docRef = this.db.collection(this.collection).doc();
            const doc = {
                ...data,
                id: docRef.id,
                createdAt: firebase.firestore.FieldValue.serverTimestamp(),
            };
            await docRef.set(doc);
            return doc;
        };
        this.findById = async (hooksId) => {
            const doc = await this.db.collection(this.collection).doc(hooksId).get();
            if (!doc.exists)
                return null;
            return doc.data();
        };
        this.db = db;
        this.collection = "hooks" /* COLLECTIONS.HOOKS */;
    }
}
export default HooksRepository;
