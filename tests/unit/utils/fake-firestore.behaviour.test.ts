/**
 * The test double gets tested, because a lying double is worse than no double.
 *
 * `tests/helpers/fake-firestore.ts` is the only harness in the repo that
 * actually evaluates a query, so the whole tenancy phase is asserted through
 * it. Every place it diverged from real Firestore was a place a test could pass
 * while production failed — and nothing checked the divergences, because a
 * helper is not code anyone thinks to test.
 *
 * Each case below names the real-Firestore rule it is holding the fake to.
 */

import { FakeFirestore, mockFirebase } from "../../helpers/fake-firestore";

const { __db: db, firebase } = mockFirebase() as unknown as {
  __db: FakeFirestore;
  firebase: { firestore: { FieldValue: { increment: (n: number) => unknown; delete: () => unknown } } };
};
const FieldValue = firebase.firestore.FieldValue;

beforeEach(() => db.data.clear());

describe("set() vs update() disagree about dotted keys, exactly as Firestore does", () => {
  it("set() writes a dotted key as a LITERAL field name", async () => {
    // The trap `src/repository/user.repository.ts` documents at length. The fake
    // used to route set() through the update() path, which hid it.
    await db.collection("users").doc("u1").set({ "stats.ideas": 5 });

    const stored = db.all("users")[0];
    expect(stored["stats.ideas"]).toBe(5);
    expect(stored.stats).toBeUndefined();
  });

  it("update() writes a dotted key as a nested PATH", async () => {
    await db.collection("users").doc("u1").set({ stats: { ideas: 1, scripts: 7 } });
    await db.collection("users").doc("u1").update({ "stats.ideas": 5 });

    expect(db.all("users")[0].stats).toEqual({ ideas: 5, scripts: 7 });
  });
});

describe("merge:true merges nested maps rather than replacing them", () => {
  it("keeps sibling keys inside a nested map", async () => {
    // `packaging.saveWithId` merges `itemStatuses`-shaped objects. A shallow
    // assignment drops the statuses it did not mention, and a test asserting the
    // new map still passes.
    const ref = db.collection("packaging").doc("p1");
    await ref.set({ itemStatuses: { title: "done", shorts: "not_started" } });

    await ref.set({ itemStatuses: { shorts: "done" } }, { merge: true });

    expect(db.all("packaging")[0].itemStatuses).toEqual({ title: "done", shorts: "done" });
  });

  it("set() without merge replaces the whole document", async () => {
    const ref = db.collection("packaging").doc("p1");
    await ref.set({ a: 1, b: 2 });

    await ref.set({ a: 9 });

    expect(db.all("packaging")[0]).toEqual({ a: 9 });
  });
});

describe("FieldValue sentinels resolve against what is stored", () => {
  it("increment accumulates instead of setting", async () => {
    // Modelled as the raw number, an increment became a set: call it twice with
    // 10 and the fake read 10 where production reads 20.
    const ref = db.collection("users").doc("u1");
    await ref.set({ stats: { ideas: 0 } });

    await ref.update({ "stats.ideas": FieldValue.increment(10) });
    await ref.update({ "stats.ideas": FieldValue.increment(10) });

    expect((db.all("users")[0].stats as Record<string, number>).ideas).toBe(20);
  });

  it("increment treats a missing counter as zero", async () => {
    const ref = db.collection("users").doc("u1");
    await ref.set({});

    await ref.update({ count: FieldValue.increment(3) });

    expect(db.all("users")[0].count).toBe(3);
  });

  it("delete removes the key rather than setting it undefined", async () => {
    // `undefined` leaves `"field" in doc` true, which diverges from `select()`
    // projections and from any `in`/existence check.
    const ref = db.collection("users").doc("u1");
    await ref.set({ keep: 1, drop: 2 });

    await ref.update({ drop: FieldValue.delete() });

    expect("drop" in db.all("users")[0]).toBe(false);
    expect(db.all("users")[0].keep).toBe(1);
  });
});

describe("queries answer what Firestore would answer", () => {
  it("orderBy EXCLUDES documents that lack the ordering field", async () => {
    // They are absent from the index being sorted, so they are absent from the
    // result. Including them meant a repository that stopped writing `updatedAt`
    // still listed its documents here while the real dashboard came back empty.
    db.seed("videoProjects", [
      { id: "with", accountId: "a", updatedAt: 200 },
      { id: "without", accountId: "a" },
    ]);

    const snap = await db
      .collection("videoProjects")
      .where("accountId", "==", "a")
      .orderBy("updatedAt", "desc")
      .get();

    expect(snap.docs.map((d) => d.id)).toEqual(["with"]);
  });

  it("!= excludes documents where the field is absent", async () => {
    db.seed("ideas", [
      { id: "explicit", archived: false },
      { id: "legacy" }, // predates the field
    ]);

    const snap = await db.collection("ideas").where("archived", "!=", true).get();

    expect(snap.docs.map((d) => d.id)).toEqual(["explicit"]);
  });

  it("startAfter positions on a DocumentSnapshot, which is what the repositories pass", async () => {
    // A snapshot can never `===` a field value, so the old lookup always missed
    // and returned the UNSLICED list — a broken cursor read as a working one.
    db.seed("videoProjects", [
      { id: "p1", accountId: "a", updatedAt: 300 },
      { id: "p2", accountId: "a", updatedAt: 200 },
      { id: "p3", accountId: "a", updatedAt: 100 },
    ]);
    const cursor = await db.collection("videoProjects").doc("p2").get();

    const snap = await db
      .collection("videoProjects")
      .where("accountId", "==", "a")
      .orderBy("updatedAt", "desc")
      .startAfter(cursor)
      .get();

    expect(snap.docs.map((d) => d.id)).toEqual(["p3"]);
  });

  it("refuses a cursor that names no row instead of silently returning page 1", async () => {
    db.seed("videoProjects", [{ id: "p1", accountId: "a", updatedAt: 300 }]);
    const stray = await db.collection("videoProjects").doc("missing").get();

    await expect(
      db.collection("videoProjects").orderBy("updatedAt", "desc").startAfter(stray).get()
    ).rejects.toThrow(/startAfter/);
  });
});

describe("auto-ids do not collide", () => {
  it("gives two unsaved refs different ids", () => {
    const a = db.collection("ideas").doc();
    const b = db.collection("ideas").doc();

    expect(a.id).not.toBe(b.id);
  });

  it("does not reuse an id after a delete", async () => {
    // `auto-${size + 1}` reused ids as the collection shrank, so a later write
    // silently overwrote an earlier document.
    const first = db.collection("ideas").doc();
    await first.set({ v: 1 });
    await first.delete();

    const second = db.collection("ideas").doc();

    expect(second.id).not.toBe(first.id);
  });
});
