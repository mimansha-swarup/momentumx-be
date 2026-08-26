import EventRepository from "../repository/event.repository.js";
import AccountRepository from "../repository/account.repository.js";
import UserRepository from "../repository/user.repository.js";
import AccountService from "./account.service.js";
import { EventType } from "../types/routes/event.js";

// Cross-cutting telemetry writer. Exported as a singleton (like a logger) so any
// controller can fire signals without threading a new constructor dependency
// through every route/controller. Only the repository touches Firestore.
class EventService {
  constructor(
    private repo: EventRepository,
    private accounts: AccountService
  ) {}

  // Fire-and-forget: never awaited by callers, never throws — a telemetry write
  // failure must not affect the user-facing request (§10 best-effort pattern).
  capture(
    userId: string,
    type: EventType,
    metadata?: Record<string, unknown>
  ): void {
    if (!userId) return;

    // Resolved here rather than in the signature: this singleton is called from
    // 12 controller sites with no request context, and one missed site would
    // write an untagged event. `ignoreUndefinedProperties: true` makes that
    // failure silent, hence the explicit guard rather than trusting it through.
    void this.accounts
      .ensureDefaultAccount(userId)
      .then((accountId) => {
        if (!accountId) {
          console.error(JSON.stringify({ event: "event_account_unresolved", type, userId }));
          return;
        }
        // Undefined metadata keys (e.g. PROJECT_CREATED carries either ideaId or
        // title) are dropped globally by Firestore's ignoreUndefinedProperties.
        return this.repo.add({ type, createdBy: userId, accountId, metadata });
      })
      .catch((err) => console.error("event capture failed", type, err));
  }
}

// Builds its own AccountService rather than importing the container: the
// container imports the controllers, which import THIS singleton — reaching back
// would close the cycle. Free: repositories are stateless and the uid→accountId
// cache is module-scoped, so this shares the container instance's cache.
export const eventService = new EventService(
  new EventRepository(),
  new AccountService(new AccountRepository(), new UserRepository())
);
export default EventService;
