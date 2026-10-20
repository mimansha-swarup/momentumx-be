const docs = new Map<string, any>();
jest.mock("../../../src/config/firebase", () => ({ db: { collection: () => ({ doc: (id: string) => ({ set: async (data: any) => { docs.set(id, data); } }) }) }, firebase: { firestore: { FieldValue: { serverTimestamp: () => "now" } } } }));
import EventRepository, { eventRetentionSlots, eventSlotId } from "../../../src/repository/event.repository";
import { EventType } from "../../../src/types/routes/event";
const oldSlots = process.env.EVENT_RETENTION_SLOTS;
afterEach(() => { if (oldSlots === undefined) delete process.env.EVENT_RETENTION_SLOTS; else process.env.EVENT_RETENTION_SLOTS = oldSlots; docs.clear(); });
it("bounds all new telemetry globally without TTL, regardless of event volume", async () => {
  process.env.EVENT_RETENTION_SLOTS = "3";
  const repo = new EventRepository();
  for (let i=0; i<100; i++) await repo.add({ type: EventType.EXPORT, accountId: "account-"+i, createdBy: "author", metadata: { index: i } });
  expect(docs.size).toBeLessThanOrEqual(3);
  for (const [id, data] of docs) { expect([0,1,2].map(eventSlotId)).toContain(id); expect(data.createdBy).toBe("author"); }
});
it("has a safe configurable default, disable switch and rejects invalid bounds", async () => {
  expect(eventRetentionSlots(undefined)).toBe(10000);
  expect(() => eventRetentionSlots("-1")).toThrow();
  expect(() => eventRetentionSlots("Infinity")).toThrow();
  process.env.EVENT_RETENTION_SLOTS = "0";
  await new EventRepository().add({ type: EventType.EXPORT, accountId: "account", createdBy: "author" });
  expect(docs.size).toBe(0);
});
it("drops oversized metadata instead of allowing telemetry to bypass the byte bound", async () => {
  await new EventRepository().add({ type: EventType.EXPORT, accountId: "account", createdBy: "author", metadata: { blob: "x".repeat(10000) } });
  expect([...docs.values()][0].metadata).toBeUndefined();
});
