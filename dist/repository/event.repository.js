import { createHash, randomInt } from "node:crypto";
import { db, firebase } from "../config/firebase.js";
/** A global bound, independent of tenant count or TTL/billing availability. */
export function eventRetentionSlots(value = process.env.EVENT_RETENTION_SLOTS) {
    if (value === undefined)
        return 10000;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > 100000)
        throw Error("EVENT_RETENTION_SLOTS must be an integer from 0 to 100000");
    return parsed;
}
export function eventSlotId(slot) {
    // Scatter fixed slot ids so the bounded pool does not create a sequential hotspot.
    return `retained-${createHash("sha256").update(String(slot)).digest("hex").slice(0, 32)}`;
}
class EventRepository {
    constructor() {
        this.add = async (event) => {
            const slots = eventRetentionSlots();
            if (!slots)
                return;
            // Telemetry is best effort. Oversized payloads must not defeat the storage cap.
            const metadata = event.metadata && Buffer.byteLength(JSON.stringify(event.metadata), "utf8") <= 4096 ? event.metadata : undefined;
            // ponytail: bounded random replacement is a sample, not a chronological audit log.
            // Add an external analytics sink if complete event history becomes a product need.
            await this.db.collection("events" /* COLLECTIONS.EVENTS */).doc(eventSlotId(randomInt(slots))).set({
                type: event.type, createdBy: event.createdBy, accountId: event.accountId, metadata,
                createdAt: firebase.firestore.FieldValue.serverTimestamp(),
            });
        };
        this.db = db;
    }
}
export default EventRepository;
