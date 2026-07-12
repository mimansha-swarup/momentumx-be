import EventRepository from "../repository/event.repository.js";
// Cross-cutting telemetry writer. Exported as a singleton (like a logger) so any
// controller can fire signals without threading a new constructor dependency
// through every route/controller. Only the repository touches Firestore.
class EventService {
    constructor(repo) {
        this.repo = repo;
    }
    // Fire-and-forget: never awaited by callers, never throws — a telemetry write
    // failure must not affect the user-facing request (§10 best-effort pattern).
    capture(userId, type, metadata) {
        if (!userId)
            return;
        this.repo
            .add({ type, createdBy: userId, metadata })
            .catch((err) => console.error("event capture failed", type, err));
    }
}
export const eventService = new EventService(new EventRepository());
export default EventService;
