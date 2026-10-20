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

import { FakeFirestore, fakeTimestamp, mockFirebase } from "../../helpers/fake-firestore";

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

  it("set() without merge REJECTS a delete sentinel, as Firestore does", async () => {
    // "FieldValue.delete() can only be used with update() and set() with
    // {merge:true}". Silently dropping the key made the fake more permissive
    // than production — code that throws in production passed here.
    await expect(
      db.collection("users").doc("u1").set({ gone: FieldValue.delete() })
    ).rejects.toThrow(/FieldValue.delete/);
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

  it("pages on when the cursor document is no longer in the result set", async () => {
    // Firestore positions by the cursor's ORDERED VALUES; membership in the
    // filtered result is irrelevant. `video-project.repository.list` filters
    // `isDeleted == false`, so a project soft-deleted between page 1 and "load
    // more" is exactly this case — real Firestore pages on. An earlier version
    // of this fake threw here, which is a new wrongness rather than a fix.
    db.seed("videoProjects", [
      { id: "p1", accountId: "a", updatedAt: 300, isDeleted: false },
      { id: "gone", accountId: "a", updatedAt: 200, isDeleted: true },
      { id: "p3", accountId: "a", updatedAt: 100, isDeleted: false },
    ]);
    const cursor = await db.collection("videoProjects").doc("gone").get();

    const snap = await db
      .collection("videoProjects")
      .where("isDeleted", "==", false)
      .orderBy("updatedAt", "desc")
      .startAfter(cursor)
      .get();

    expect(snap.docs.map((d) => d.id)).toEqual(["p3"]);
  });

  it("honours the second cursor value, so duplicates are not skipped", async () => {
    // `content.repository.getIdeas` passes (title, docId) because two ideas can
    // share a title and a single-value cursor skips every duplicate after the
    // first. Reading only `after[0]` implemented exactly the bug the second
    // value exists to prevent, invisibly.
    db.seed("ideas", [
      { id: "a", accountId: "x", title: "Same" },
      { id: "b", accountId: "x", title: "Same" },
      { id: "c", accountId: "x", title: "Same" },
    ]);

    const snap = await db
      .collection("ideas")
      .where("accountId", "==", "x")
      .orderBy("title")
      .orderBy({ __name__: "__name__" } as never)
      .startAfter("Same", "a")
      .get();

    expect(snap.docs.map((d) => d.id)).toEqual(["b", "c"]);
  });

  it("orders strings by byte/codepoint order, not locale collation", async () => {
    // order.js:79-85's `primitiveComparator` (used for stringValue at :241) is
    // plain `<`/`>` on the JS string, not `localeCompare`. localeCompare("a",
    // "é") treats them as collation neighbours; byte order does not:
    // "Z" (0x5A) < "a" (0x61) < "é" (0xE9), so the two disagree on this exact
    // input, and localeCompare silently reordered the result relative to what
    // production returns.
    db.seed("ideas", [
      { id: "1", title: "a" },
      { id: "2", title: "é" },
      { id: "3", title: "Z" },
    ]);

    const snap = await db.collection("ideas").orderBy("title").get();

    expect(snap.docs.map((d) => d.get("title"))).toEqual(["Z", "a", "é"]);
  });

  it("breaks a tie on the ordered field by document id, like the real implicit orderBy", async () => {
    // query.js's `comparator()` (:1059-1064) and `createImplicitOrderBy`
    // (:497-517) both append `__name__` — in the direction of the last
    // explicit orderBy — whenever it isn't already declared. Without it, two
    // rows tied on "n" compare equal, and `startAfter(snapshot(a))` either
    // drops or keeps "b" by coincidence of iteration order instead of by the
    // doc-id tie-break production actually uses.
    db.seed("videoProjects", [
      { id: "a", n: 1 },
      { id: "b", n: 1 },
      { id: "c", n: 2 },
    ]);
    const cursor = await db.collection("videoProjects").doc("a").get();

    const snap = await db.collection("videoProjects").orderBy("n").startAfter(cursor).get();

    expect(snap.docs.map((d) => d.id)).toEqual(["b", "c"]);
  });
});

describe("range operators (>, >=, <, <=)", () => {
  it("excludes documents where the range-filtered field is missing", async () => {
    // Same rule as `!=`, and for the same reason `orderBy` drops them: an
    // inequality filter's field is implicitly ordered by (`getInequality
    // FilterFields`, query.js:463-476), and there is nothing indexed to
    // compare a missing field against — it is excluded, not treated as 0.
    db.seed("invites", [
      { id: "live", expiresAt: 500 },
      { id: "legacy" }, // predates the field
    ]);

    const snap = await db.collection("invites").where("expiresAt", ">", 100).get();

    expect(snap.docs.map((d) => d.id)).toEqual(["live"]);
  });

  it("compares numbers and Timestamp-likes by millisecond value", async () => {
    db.seed("invites", [
      { id: "expired", expiresAt: fakeTimestamp(100) },
      { id: "live", expiresAt: fakeTimestamp(500) },
    ]);

    const snap = await db.collection("invites").where("expiresAt", ">", fakeTimestamp(200)).get();

    expect(snap.docs.map((d) => d.id)).toEqual(["live"]);
  });

  it("compares strings by the same byte order orderBy uses, not localeCompare", async () => {
    // Regression guard for the two comparators disagreeing: localeCompare
    // would put "é" ahead of "Z" (locale collation); byte order — what
    // `compareOrdered` and `orderBy` both use — does not.
    db.seed("ideas", [
      { id: "a", title: "a" },
      { id: "z", title: "Z" },
      { id: "e", title: "é" },
    ]);

    const snap = await db.collection("ideas").where("title", ">=", "Z").get();

    expect(snap.docs.map((d) => d.id).sort()).toEqual(["a", "e", "z"]);
  });

  it("rejects a range filter combined with an orderBy on a different field", async () => {
    // The server rejects this ("inequality filter field must be the first
    // orderBy field"); a fake that silently accepted it would pass a test
    // production fails on.
    db.seed("invites", [{ id: "i1", expiresAt: 500, createdAt: 1 }]);

    await expect(
      db.collection("invites").where("expiresAt", ">", 100).orderBy("createdAt").get()
    ).rejects.toThrow(/must be the first orderBy field/);

    // Ordering by the SAME field the range filter targets is fine.
    await expect(
      db.collection("invites").where("expiresAt", ">", 100).orderBy("expiresAt").get()
    ).resolves.toMatchObject({ size: 1 });
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

// ---------------------------------------------------------------------------
// Added 2026-09-27 with the repository behaviour rewrite. These four semantics
// are what let `content.repository` and `packaging.repository` be tested by
// RESULT instead of by which SDK methods were called, so each one is now load
// bearing and gets held to the real rule.
// ---------------------------------------------------------------------------

describe("range bounds — startAt / endAt are inclusive, startAfter is not", () => {
  beforeEach(() =>
    db.seed("ideas", [
      { id: "a", title: "How to bake" },
      { id: "b", title: "How to braise" },
      { id: "c", title: "Zebra" },
    ])
  );

  it("bounds a prefix search from both ends", async () => {
    // Exactly what `content.repository.getIdeas` does for an active search. A
    // fake that ignored these returned the whole channel from a query that in
    // production returns only matches.
    const snap = await db
      .collection("ideas")
      .orderBy("title")
      .startAt("How to b")
      .endAt("How to b")
      .get();

    expect(snap.docs.map((d) => d.id)).toEqual(["a", "b"]);
  });

  it("includes the row it starts AT and excludes the row it starts AFTER", async () => {
    const at = await db.collection("ideas").orderBy("title").startAt("How to braise").get();
    const after = await db.collection("ideas").orderBy("title").startAfter("How to braise").get();

    expect(at.docs.map((d) => d.id)).toEqual(["b", "c"]);
    expect(after.docs.map((d) => d.id)).toEqual(["c"]);
  });
});

describe("a transaction runs every read before any write, as Firestore requires", () => {
  it("rejects a read issued after a write", async () => {
    await db.collection("packaging").doc("p1").set({ v: 1 });

    await expect(
      db.runTransaction(async (txn) => {
        const ref = db.collection("packaging").doc("p1");
        txn.update(ref, { v: 2 });
        // Real Firestore: "Firestore transactions require all reads to be
        // executed before all writes". A permissive fake blesses a
        // read-modify-write that throws on every request in production.
        return txn.get(ref);
      })
    ).rejects.toThrow(/reads to be executed before all writes/);
  });

  it("allows the read-modify-write order the repositories actually use", async () => {
    await db.collection("packaging").doc("p1").set({ v: 1 });

    await db.runTransaction(async (txn) => {
      const ref = db.collection("packaging").doc("p1");
      const snap = (await txn.get(ref)) as { data: () => Record<string, number> };
      txn.update(ref, { v: snap.data().v + 1 });
    });

    expect(db.all("packaging")[0].v).toBe(2);
  });
});

describe("create() enforces the {exists:false} precondition, unlike set()", () => {
  // write-batch.js:152-160: `create()` builds the same write `set()` does,
  // PLUS `Precondition({exists:false})` — the server refuses with
  // ALREADY_EXISTS when the document is already there. That refusal is the
  // entire reason a repository reaches for `create` over `set`; aliasing it
  // to `set` (as a workaround had to, before this) silently drops it.
  it("txn.create() throws when the document already exists", async () => {
    await db.collection("accounts").doc("acc-1").set({ v: 1 });

    await expect(
      db.runTransaction(async (txn) => {
        txn.create(db.collection("accounts").doc("acc-1"), { v: 2 });
      })
    ).rejects.toThrow(/ALREADY_EXISTS/);
    // And the failed create must not have overwritten the existing document —
    // same all-or-nothing rollback as every other transaction failure.
    expect(db.all("accounts")[0].v).toBe(1);
  });

  it("txn.create() succeeds when the document does not exist yet", async () => {
    await db.runTransaction(async (txn) => {
      txn.create(db.collection("accounts").doc("acc-2"), { v: 1 });
    });

    expect(db.all("accounts")).toEqual([{ v: 1 }]);
  });

  it("batch().create() throws when the document already exists", async () => {
    await db.collection("accounts").doc("acc-3").set({ v: 1 });

    const batch = db.batch();
    batch.create(db.collection("accounts").doc("acc-3"), { v: 2 });

    await expect(batch.commit()).rejects.toThrow(/ALREADY_EXISTS/);
  });
});

describe("doc() splits on '/', so a malformed id is not just a missing document", () => {
  it("throws when the path addresses a collection", () => {
    // `GET /v1/packaging/a%2Fb` decodes to "a/b". This is why `isDocumentId`
    // exists; a fake that accepted it as a key could not tell a repository that
    // still has the guard from one that lost it.
    expect(() => db.collection("packaging").doc("a/b")).toThrow(/not a document/);
  });

  it("resolves an odd path as a sub-collection document", async () => {
    await db.collection("accounts").doc("acc-1/context/channel").set({ niche: "cooking" });

    expect(db.all("accounts/acc-1/context")).toEqual([{ niche: "cooking" }]);
  });

  it("throws on an empty document id, exactly as validateResourcePath does", () => {
    // path.js:446-447: `resourcePath === ''` is "must be a non-empty string".
    // Splitting first (the old order here) let an explicit "" through as an
    // ordinary key instead of throwing.
    expect(() => db.collection("packaging").doc("")).toThrow(/non-empty string/);
  });

  it('throws on an internal "//", exactly as validateResourcePath does', () => {
    // path.js:449-450: any "//" is "must not contain //" — checked before the
    // id is split, same as the empty-string case. `X-Account-Id: <id>/context/
    // channel` is the real-world shape this guards against; a "//" inside a
    // supposedly-opaque id is the same class of malformed input.
    expect(() => db.collection("packaging").doc("a//b")).toThrow(/must not contain/);
  });

  it("normalises a leading or trailing '/', rather than rejecting it", async () => {
    // Path.split() (path.js:262-265) filters out empty segments, so a stray
    // leading/trailing slash is normalised away, not rejected — "/i1" and "i1/"
    // both resolve to the single segment "i1". A fake that split naively (no
    // filter) would count a leading "/" as an extra empty segment and
    // misjudge the collection/document parity.
    await db.collection("ideas").doc("/i1").set({ v: 1 });
    await db.collection("ideas").doc("i1/").set({ v: 2 }, { merge: true });

    expect(db.all("ideas")).toEqual([{ v: 2 }]);
    expect((await db.collection("ideas").doc("i1").get()).exists).toBe(true);
  });
});

describe("serverTimestamp is distinguishable from a client clock", () => {
  it("resolves to a Timestamp at write time, tagged as server-minted", async () => {
    const { isServerTimestamp } = require("../../helpers/fake-firestore");
    const serverTimestamp = (
      firebase.firestore.FieldValue as unknown as { serverTimestamp: () => unknown }
    ).serverTimestamp;

    await db.collection("ideas").doc("i1").set({ createdAt: serverTimestamp() });

    const stored = db.all("ideas")[0].createdAt as { toDate: () => Date };
    // Repositories read these back with `.toDate()`; as a bare number that threw.
    expect(stored.toDate()).toBeInstanceOf(Date);
    expect(isServerTimestamp(stored)).toBe(true);
    // And a client-side stamp is NOT mistaken for one, which is the only way a
    // test can hold `firestore-conventions.md` to "never `new Date()`".
    expect(isServerTimestamp(new Date())).toBe(false);
    expect(isServerTimestamp(Date.now())).toBe(false);
  });
});

describe("the divergences that made a passing test a lie", () => {
  it("keeps a real SDK Timestamp's methods instead of flattening it to a bare map", async () => {
    // A firebase-admin Timestamp carries toMillis/toDate on its PROTOTYPE. The fake
    // recursed into every object to resolve nested sentinels, which rebuilt it from own
    // enumerable properties only — producing `{ _seconds, _nanoseconds }` with no
    // methods. The fake's OWN timestamps survived that, because theirs are own
    // properties, which is exactly why the bug was invisible here.
    class SdkTimestamp {
      constructor(private readonly ms: number) {}
      toMillis() {
        return this.ms;
      }
      toDate() {
        return new Date(this.ms);
      }
    }
    const stamp = new SdkTimestamp(1_700_000_000_000);

    await db.collection("billing").doc("payer").set({ locks: { hooks: { startedAt: stamp } } });

    const stored = db.all("billing")[0].locks as { hooks: { startedAt: SdkTimestamp } };
    expect(typeof stored.hooks.startedAt.toMillis).toBe("function");
    expect(stored.hooks.startedAt.toMillis()).toBe(1_700_000_000_000);
  });

  it("set(..., {merge:true}) ACCEPTS a FieldValue.delete() nested inside a map, at any depth", async () => {
    // write-batch.js:263-264 passes `allowDeletes: !!(mergePaths || mergeLeaves)`
    // into `validateDocumentData`, which maps a truthy value to 'all' (:610) —
    // and serializer.js's `validateUserInput` only refuses a delete for 'none'
    // or (at the wrong level) 'root'; 'all' hits neither, so it's never refused.
    // The fake used to throw here, which was backwards: it was more RESTRICTIVE
    // than production, not more permissive.
    await db.collection("billing").doc("payer").set({ locks: { hooks: { token: "t" }, other: "keep" } });

    await db
      .collection("billing")
      .doc("payer")
      .set({ locks: { hooks: FieldValue.delete() } }, { merge: true });

    const locks = db.all("billing")[0].locks as Record<string, unknown>;
    expect(locks.hooks).toBeUndefined();
    // Deleting one leaf must not disturb its sibling.
    expect(locks.other).toBe("keep");
  });

  it("update() still REFUSES a FieldValue.delete() nested inside a plain-object value", async () => {
    // update()'s own validation is 'root'-scoped (write-batch.js:659-667 →
    // serializer.js's validateUserInput): a delete is only legal at level 0
    // (`update({ field: FieldValue.delete() })`) or at level 1 with a single
    // path segment — which is exactly the dotted-key form below, since
    // `FieldPath.fromArgument` only splits "a.b" on dots when addressing the
    // update, not when `validateUpdateMap` walks the raw key for validation.
    // A delete buried inside an actual sub-object is illegal in production, so
    // the fake still refuses it rather than silently keeping the field.
    await db.collection("billing").doc("payer").set({ locks: { hooks: { token: "t" } } });

    await expect(
      db.collection("billing").doc("payer").update({ locks: { hooks: FieldValue.delete() } })
    ).rejects.toThrow(/nested inside a map field/);

    // The documented alternative — a dotted path — still works.
    await db.collection("billing").doc("payer").update({ "locks.hooks": FieldValue.delete() });
    expect((db.all("billing")[0].locks as Record<string, unknown>).hooks).toBeUndefined();
  });

  it("rolls a transaction back when a later write throws, instead of half-applying it", async () => {
    // Firestore never produces a partial commit. Staged writes were applied one at a
    // time, so a throw partway left its predecessors persisted — and a test asserting
    // on the store then read a state production cannot reach.
    db.seed("accounts", [{ id: "acc-1", displayName: "Before" }]);

    await expect(
      db.runTransaction(async (txn) => {
        txn.update(db.collection("accounts").doc("acc-1"), { displayName: "After" });
        // update() on a document that does not exist is an error, as in production.
        txn.update(db.collection("accounts").doc("missing"), { displayName: "Nope" });
      })
    ).rejects.toThrow();

    expect(db.all("accounts")[0].displayName).toBe("Before");
  });
});

describe(".data() and .get() hand back an independent copy, not a store alias", () => {
  // Real Firestore deserialises a fresh object on every call; nothing a
  // caller does to what it reads can reach the database without a write. The
  // old shallow `{ ...data }` copied only the top level, so mutating a NESTED
  // object on a "read" silently corrupted the stored document.
  it("mutating a nested object from .data() does not touch the store", async () => {
    await db.collection("accounts").doc("acc-1").set({ members: { alice: { role: "owner" } } });

    const first = (await db.collection("accounts").doc("acc-1").get()).data() as {
      members: Record<string, { role: string }>;
    };
    first.members.alice.role = "editor"; // mutate the read

    const second = (await db.collection("accounts").doc("acc-1").get()).data() as {
      members: Record<string, { role: string }>;
    };
    expect(second.members.alice.role).toBe("owner");
  });

  it("two reads of the same document do not alias the same nested object", async () => {
    // The concrete failure mode: two transactions reading the same doc must
    // not share one `members` object between them.
    await db.collection("accounts").doc("acc-1").set({ members: { alice: { role: "owner" } } });

    const a = (await db.collection("accounts").doc("acc-1").get()).data() as {
      members: Record<string, unknown>;
    };
    const b = (await db.collection("accounts").doc("acc-1").get()).data() as {
      members: Record<string, unknown>;
    };
    expect(a.members).not.toBe(b.members);
  });

  it("preserves Timestamp-like values as themselves rather than plain-object-cloning them", async () => {
    const stamp = fakeTimestamp(1_700_000_000_000);
    await db.collection("accounts").doc("acc-1").set({ locks: { hooks: { startedAt: stamp } } });

    const data = (await db.collection("accounts").doc("acc-1").get()).data() as {
      locks: { hooks: { startedAt: { toMillis: () => number } } };
    };
    expect(typeof data.locks.hooks.startedAt.toMillis).toBe("function");
    expect(data.locks.hooks.startedAt.toMillis()).toBe(1_700_000_000_000);
  });

  it("mutating a nested object from .get(field) does not touch the store either", async () => {
    await db.collection("accounts").doc("acc-1").set({ members: { alice: { role: "owner" } } });

    const read = await db.collection("accounts").doc("acc-1").get();
    const members = read.get("members") as Record<string, { role: string }>;
    members.alice.role = "editor";

    const after = (await db.collection("accounts").doc("acc-1").get()).data() as {
      members: Record<string, { role: string }>;
    };
    expect(after.members.alice.role).toBe("owner");
  });
});
