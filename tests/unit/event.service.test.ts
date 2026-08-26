jest.mock("firebase-admin", () => ({
  apps: [],
  initializeApp: jest.fn(),
  credential: { cert: jest.fn() },
  firestore: Object.assign(jest.fn().mockReturnValue({}), {
    FieldValue: { serverTimestamp: jest.fn() },
  }),
}));

jest.mock("../../src/config/firebase", () => ({
  db: {},
  firebase: { firestore: { FieldValue: { serverTimestamp: jest.fn() } } },
}));

import EventService from "../../src/service/event.service";
import EventRepository from "../../src/repository/event.repository";
import { EventType } from "../../src/types/routes/event";
import { makeTestAccountService, TEST_ACCOUNT_ID } from "../helpers/account";

const flush = () => new Promise((resolve) => setImmediate(resolve));
const makeRepo = (add: jest.Mock) => ({ add } as unknown as EventRepository);

describe("EventService.capture", () => {
  it("writes the event through the repository", async () => {
    const add = jest.fn().mockResolvedValue(undefined);
    new EventService(makeRepo(add), makeTestAccountService()).capture("user-1", EventType.EXPORT, {
      resource: "idea",
    });
    await flush();
    expect(add).toHaveBeenCalledWith({
      type: EventType.EXPORT,
      createdBy: "user-1",
      // Phase 03. Per-channel usage reporting is the whole point of tagging
      // events, and this is the write most likely to lose the field silently —
      // `ignoreUndefinedProperties` would drop it with no error anywhere.
      accountId: TEST_ACCOUNT_ID,
      metadata: { resource: "idea" },
    });
  });

  it("never throws when the repository write fails (fire-and-forget)", async () => {
    const spy = jest.spyOn(console, "error").mockImplementation(() => {});
    const add = jest.fn().mockRejectedValue(new Error("firestore down"));
    const svc = new EventService(makeRepo(add), makeTestAccountService());
    expect(() => svc.capture("user-1", EventType.REGENERATE)).not.toThrow();
    await flush(); // an uncaught rejection here would fail the test
    expect(add).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("no-ops when userId is missing", () => {
    const add = jest.fn();
    new EventService(makeRepo(add), makeTestAccountService()).capture("", EventType.HOOK_SELECTED);
    expect(add).not.toHaveBeenCalled();
  });
});
