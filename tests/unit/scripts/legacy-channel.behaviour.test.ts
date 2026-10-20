import { legacyFields, legacyPatch, processLegacyUsers } from "../../../scripts/legacy-channel";
import { FakeFirestore } from "../../helpers/fake-firestore";
const identity = { email: "owner@example.com", password: "private", refreshToken: "private", stats: { ideas: 12 }, createdBy: "author", lastActiveAccountId: "channel" };
it("snapshots only legacy channel fields, retaining data and excluding credentials/identity", () => {
  const original = { ...identity, niche: "Cooking", competitors: [{ url: "https://youtube.com/@other", titles: ["Soup"] }] };
  const patch = legacyPatch(original, "snapshot", new Date("2026-09-26T00:00:00Z")) as any;
  expect(patch.legacyChannelSnapshot.fields).toEqual({ niche: "Cooking", competitors: original.competitors });
  expect(patch.legacyChannelSnapshot.retainUntil).toBe("2026-12-25T00:00:00.000Z");
  expect(JSON.stringify(patch)).not.toContain("private");
  expect(original).toMatchObject(identity);
});
it("never overwrites the original snapshot or current fields during restore", () => {
  const snapshot = (legacyPatch({ niche: "Old", website: "https://example.com" }, "snapshot") as any).legacyChannelSnapshot;
  const current = { ...identity, niche: "New", legacyChannelSnapshot: snapshot };
  expect(legacyPatch(current, "snapshot")).toEqual({});
  expect(legacyPatch(current, "restore")).toEqual({ website: "https://example.com" });
  const restored = { ...current, ...legacyPatch(current, "restore") };
  expect(legacyFields(restored)).toEqual({ niche: "New", website: "https://example.com" });
  expect(legacyPatch(restored, "restore")).toEqual({});
});
it("restore refuses injected non-channel fields and oversized snapshots", () => {
  expect(legacyPatch({ legacyChannelSnapshot: { version: 1, fields: { ...identity, niche: "Cooking" } } }, "restore")).toEqual({ niche: "Cooking" });
  expect(() => legacyPatch({ websiteContent: "x".repeat(500000) }, "snapshot")).toThrow("size limit");
});
it("CLI engine defaults dry-run and snapshot/restore writes preserve authored and identity fields", async () => {
  const db = new FakeFirestore();
  db.seed("users", [{ id: "user", ...identity, niche: "Cooking" }]);
  const dry = await processLegacyUsers(db as never, { mode: "snapshot" });
  expect(dry.written).toBe(0);
  expect(db.all("users")[0].legacyChannelSnapshot).toBeUndefined();
  const applied = await processLegacyUsers(db as never, { mode: "snapshot", apply: true });
  expect(applied.written).toBe(1);
  const current = db.col("users").get("user")!;
  delete current.niche; // Fixture simulates a future separately-authorized cleanup.
  await processLegacyUsers(db as never, { mode: "restore", apply: true });
  expect(db.all("users")[0]).toMatchObject({ ...identity, niche: "Cooking" });
});
