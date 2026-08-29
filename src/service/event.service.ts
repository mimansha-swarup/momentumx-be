import EventRepository from "../repository/event.repository.js";
import { EventType } from "../types/routes/event.js";
import { RecordOwner } from "../utlils/content.js";

// Cross-cutting telemetry writer. Exported as a singleton (like a logger) so any
// controller can fire signals without threading a new constructor dependency
// through every route/controller. Only the repository touches Firestore.
class EventService {
  constructor(private repo: EventRepository) {}

  // Fire-and-forget: never awaited by callers, never throws — a telemetry write
  // failure must not affect the user-facing request (§10 best-effort pattern).
  capture(
    owner: RecordOwner,
    type: EventType,
    metadata?: Record<string, unknown>
  ): void {
    const { userId, accountId } = owner ?? {};
    // Both, explicitly. The account used to be resolved here with
    // `ensureDefaultAccount`, because this singleton had no request context — so
    // an event was tagged with the user's DEFAULT channel rather than the one they
    // were acting in. Phase 06 gives every controller `ownerOf(req)`, so the
    // active account travels in. An untagged event is worse than a missing one:
    // `ignoreUndefinedProperties: true` drops the field and the write still
    // succeeds, so it fails silently.
    if (!userId || !accountId) {
      console.error(JSON.stringify({ event: "event_owner_missing", type, userId: userId ?? null }));
      return;
    }

    // Undefined metadata keys (e.g. PROJECT_CREATED carries either ideaId or
    // title) are dropped globally by Firestore's ignoreUndefinedProperties.
    void this.repo
      .add({ type, createdBy: userId, accountId, metadata })
      .catch((err) => console.error("event capture failed", type, err));
  }
}

// A bare repository now. It used to carry an AccountService purely to resolve the
// account, built here rather than taken from the container because the container
// imports the controllers, which import THIS singleton — reaching back would close
// the cycle. The account arrives with the caller instead, so the dependency is gone
// and so is the cycle it worked around.
export const eventService = new EventService(
  new EventRepository()
);
export default EventService;
