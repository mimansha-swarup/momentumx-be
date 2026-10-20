import { generationWrite } from "./generation-guard.js";
import { isDocumentId } from "../utlils/firestore-id.js";
import { db, firebase } from "../config/firebase.js";
class HooksRepository {
    constructor() {
        this.save = async (data, charge) => {
            const docRef = this.db.collection(this.collection).doc();
            const doc = {
                ...data,
                id: docRef.id,
                createdAt: firebase.firestore.FieldValue.serverTimestamp(),
            };
            if (charge)
                await generationWrite(charge, tx => tx.set(docRef, doc));
            else
                await docRef.set(doc);
            return doc;
        };
        this.findById = async (hooksId) => {
            // A route param reaching `.doc()` unchecked: `GET /v1/…/a%2Fb` decodes to
            // "a/b", which addresses a COLLECTION and throws a bare Error — rendered as
            // 500 "Something went wrong" where the honest answer is not-found.
            if (!isDocumentId(hooksId))
                return null;
            const doc = await this.db.collection(this.collection).doc(hooksId).get();
            if (!doc.exists)
                return null;
            return doc.data();
        };
        this.update = async (hooksId, data, charge) => {
            const ref = this.db.collection(this.collection).doc(hooksId);
            if (charge)
                await generationWrite(charge, tx => tx.update(ref, data));
            else
                await ref.update(data);
        };
        this.db = db;
        this.collection = "hooks" /* COLLECTIONS.HOOKS */;
    }
}
export default HooksRepository;
