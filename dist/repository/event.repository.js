import { db, firebase } from "../config/firebase.js";
class EventRepository {
    constructor() {
        // Firestore auto-ID — an append-only telemetry stream, never read by doc id.
        this.add = async (event) => {
            await this.db.collection(this.collection).add({
                ...event,
                createdAt: firebase.firestore.FieldValue.serverTimestamp(),
            });
        };
        this.db = db;
        this.collection = "events" /* COLLECTIONS.EVENTS */;
    }
}
export default EventRepository;
