// Phase 04 backfill, tested against the failure modes the phase document names
// rather than against the implementation.
//
// This job runs once, against production, over records that have no other copy.
// Its two destructive outcomes are both SILENT:
//
//   1. A guessed owner. `createdBy: ""` copied straight through is a real value
//      shared by every such record across ALL users, merging unrelated people
//      into one fake account — the exact data-mixing this migration exists to
//      prevent.
//   2. A write that no-ops. `ignoreUndefinedProperties: true` means
//      `set({ accountId: undefined }, { merge })` writes nothing and reports
//      success: the document stays untagged while `patched` increments, and it
//      vanishes for its owner when Phase 06 flips reads.
//
// Neither shows up in a "did every document get a field?" check, which is why the
// verification pass asserts the mapped value instead.

const FieldPath = { documentId: () => "__name__" };

const collectionFn = jest.fn();
// Resolved, not bare: the job discards the write promises, so it attaches a
// `.catch` to keep a failed write from taking the process down as an unhandled
// rejection. A mock returning undefined would break on that `.catch`.
const bulkWriterSet = jest.fn().mockResolvedValue(undefined);
/** Write failures the fake BulkWriter should surface while flushing. */
type FakeWriteError = { code: number; failedAttempts: number; documentRef: { path: string } };
const pendingWriteErrors: FakeWriteError[] = [];
let writeErrorHandler: ((e: FakeWriteError) => boolean) | undefined;

const bulkWriterOnWriteError = jest.fn((cb: (e: FakeWriteError) => boolean) => {
  writeErrorHandler = cb;
});
// A real BulkWriter reports failures through the error handler as it flushes,
// which is what makes them countable before the job returns its summary.
const drain = () => {
  while (pendingWriteErrors.length) writeErrorHandler?.(pendingWriteErrors.shift()!);
};
/** What the job did, in order — the cursor test is entirely about sequence. */
const order: string[] = [];
const bulkWriterClose = jest.fn(async () => drain());
const bulkWriterFlush = jest.fn(async () => {
  order.push("flush");
  drain();
});
const progressSet = jest.fn(
  async (data: Record<string, unknown>, ..._rest: unknown[]) => {
    if (data.lastCursor) order.push("cursor");
  }
);
const progressGet = jest.fn().mockResolvedValue({ get: () => undefined });

jest.mock("firebase-admin/firestore", () => ({ FieldPath }));
jest.mock("../../../src/config/firebase", () => ({
  db: {
    collection: (...args: unknown[]) => collectionFn(...args),
    bulkWriter: () => ({
      set: bulkWriterSet,
      close: bulkWriterClose,
      flush: bulkWriterFlush,
      onWriteError: bulkWriterOnWriteError,
    }),
  },
  firebase: { firestore: { FieldValue: { serverTimestamp: () => "server-ts" } } },
}));

import {
  backfillCollection,
  buildOwnerMap,
  ORPHAN,
  resolveAccountId,
  verifyCollection,
  verifyDoc,
  BACKFILL_COLLECTIONS,
  pickCollections,
} from "../../../src/scripts/backfill-account-id";

const ACC_A = "acc-aaaaaaaa-1111-4111-8111-111111111111";
const ACC_B = "acc-bbbbbbbb-2222-4222-8222-222222222222";
const MAP = new Map([
  ["uid-a", ACC_A],
  ["uid-b", ACC_B],
]);

/** A page of documents shaped like a Firestore QuerySnapshot. */
const page = (docs: Record<string, unknown>[], path = "ideas") => ({
  empty: docs.length === 0,
  size: docs.length,
  docs: docs.map((data, i) => ({
    id: `doc-${i}`,
    ref: { id: `doc-${i}`, path: `${path}/doc-${i}` },
    get: (field: string) => data[field],
  })),
});

/** Wires db.collection() so the scanned collection returns `pages` in order. */
const withPages = (pages: unknown[], target = "ideas") => {
  let call = 0;
  collectionFn.mockImplementation((name: string) => {
    if (name === "migrations") {
      return { doc: () => ({ get: progressGet, set: progressSet }) };
    }
    const query = {
      orderBy: () => query,
      limit: () => query,
      startAfter: () => query,
      get: async () => (name === target ? pages[call++] ?? page([]) : page([])),
    };
    return query;
  });
};

beforeEach(() => {
  jest.clearAllMocks();
  progressGet.mockResolvedValue({ get: () => undefined });
  pendingWriteErrors.length = 0;
  writeErrorHandler = undefined;
  order.length = 0;
});

describe("the resume cursor never runs ahead of the writes", () => {
  it("flushes the page's writes before storing lastCursor", async () => {
    // `set()` only enqueues — BulkWriter batches, rate limits and retries on its
    // own schedule. Storing the cursor first makes it claim a durability the data
    // does not have: kill the process there and those documents are skipped by
    // every later run, because resume starts PAST them. `--verify` would call
    // them `missing` and the obvious repair — re-run the job — would fix nothing.
    withPages([page([{ createdBy: "uid-a" }, { createdBy: "uid-b" }])]);

    await backfillCollection("ideas", MAP, { resume: false });

    expect(order).toEqual(["flush", "cursor"]);
  });
});

describe("a write that fails is not reported as a clean run", () => {
  const failure = (over: Partial<FakeWriteError> = {}): FakeWriteError => ({
    code: 7, // PERMISSION_DENIED — permanent
    failedAttempts: 1,
    documentRef: { path: "ideas/doc-0" },
    ...over,
  });

  it("counts it, and the summary says so", async () => {
    // `patched` counts writes ATTEMPTED — all the scan loop can know, since
    // BulkWriter completes them afterwards. Without a failure counter the job
    // prints `patched: 1` for a document that never got its accountId, and the
    // next person reads that as done.
    withPages([page([{ createdBy: "uid-a" }])]);
    pendingWriteErrors.push(failure());

    const counts = await backfillCollection("ideas", MAP);

    expect(counts).toMatchObject({ patched: 1, failed: 1 });
  });

  it("retries the transient codes, and only those", () => {
    // Installing a handler REPLACES BulkWriter's own, so this one has to
    // reproduce its policy: ABORTED and UNAVAILABLE, up to ten attempts.
    //
    // A generic `failedAttempts < 3` looks like a safe default and loses in both
    // directions — it burns attempts on permanent errors, and it abandons a
    // document on a transient blip the default would have ridden out. On a
    // one-shot job over records with no other copy, that is the wrong trade.
    withPages([page([])]);
    return backfillCollection("ideas", MAP).then(() => {
      expect(writeErrorHandler).toBeDefined();

      expect(writeErrorHandler!(failure({ code: 14, failedAttempts: 1 }))).toBe(true); // UNAVAILABLE
      expect(writeErrorHandler!(failure({ code: 10, failedAttempts: 9 }))).toBe(true); // ABORTED
      expect(writeErrorHandler!(failure({ code: 14, failedAttempts: 10 }))).toBe(false); // out of attempts
      expect(writeErrorHandler!(failure({ code: 7, failedAttempts: 1 }))).toBe(false); // permanent
      expect(writeErrorHandler!(failure({ code: 3, failedAttempts: 1 }))).toBe(false); // INVALID_ARGUMENT
    });
  });
});

describe("the owner map", () => {
  it("maps every owner uid to its account", () => {
    const map = buildOwnerMap([
      { id: ACC_A, ownerUids: ["uid-a"] },
      { id: ACC_B, ownerUids: ["uid-b"] },
    ]);

    expect(map.get("uid-a")).toBe(ACC_A);
    expect(map.get("uid-b")).toBe(ACC_B);
  });

  it("ignores accounts with no owners rather than mapping undefined", () => {
    const map = buildOwnerMap([
      { id: ACC_A, ownerUids: [] },
      { id: ACC_B },
      { id: ACC_A, ownerUids: [""] },
    ]);

    expect(map.size).toBe(0);
  });
});

describe("resolving one document's owner — never guesses, never returns undefined", () => {
  // Every one of these must be a non-empty string. `undefined` reaching the write
  // is the silent no-op described at the top of this file.
  it.each([
    ["a known owner", "uid-a", ACC_A],
    ["an EMPTY-STRING owner (the Phase 01 bug)", "", ORPHAN],
    ["an ABSENT owner", undefined, ORPHAN],
    ["a null owner", null, ORPHAN],
    ["a non-string owner", 42, ORPHAN],
    ["an owner with no account", "uid-unknown", ORPHAN],
  ])("%s resolves to a usable id", (_label, owner, expected) => {
    const resolved = resolveAccountId(owner, MAP);

    expect(resolved).toBe(expected);
    expect(typeof resolved).toBe("string");
    expect(resolved.length).toBeGreaterThan(0);
  });

  it("never resolves one user's record to another user's account", () => {
    expect(resolveAccountId("uid-a", MAP)).not.toBe(ACC_B);
  });
});

describe("the backfill pass", () => {
  it("writes the mapped account, not the uid", async () => {
    withPages([page([{ createdBy: "uid-a" }])]);

    const counts = await backfillCollection("ideas", MAP);

    expect(bulkWriterSet).toHaveBeenCalledWith(
      expect.objectContaining({ path: "ideas/doc-0" }),
      { accountId: ACC_A },
      { merge: true }
    );
    // The uid must never be the written value — that shortcut is dead, and it
    // would still isolate correctly between users, so nothing downstream sees it.
    expect(bulkWriterSet.mock.calls[0][1].accountId).not.toBe("uid-a");
    expect(counts).toMatchObject({ scanned: 1, patched: 1, orphaned: 0 });
  });

  it("quarantines an empty-string owner instead of copying it through", async () => {
    withPages([page([{ createdBy: "" }])]);

    const counts = await backfillCollection("ideas", MAP);

    expect(bulkWriterSet).toHaveBeenCalledWith(expect.anything(), { accountId: ORPHAN }, { merge: true });
    expect(bulkWriterSet.mock.calls[0][1].accountId).not.toBe("");
    expect(counts.orphaned).toBe(1);
  });

  it("never hands undefined to the write, for a document with no createdBy at all", async () => {
    // The quiet one. This write would succeed and change nothing.
    withPages([page([{ title: "an orphan" }])]);

    await backfillCollection("ideas", MAP);

    const [, written] = bulkWriterSet.mock.calls[0];
    expect(written.accountId).toBeDefined();
    expect(written.accountId).toBe(ORPHAN);
  });

  it("skips documents that already carry an accountId, so a re-run is safe", async () => {
    withPages([page([{ createdBy: "uid-a", accountId: ACC_A }, { createdBy: "uid-b" }])]);

    const counts = await backfillCollection("ideas", MAP);

    expect(bulkWriterSet).toHaveBeenCalledTimes(1);
    expect(bulkWriterSet.mock.calls[0][1]).toEqual({ accountId: ACC_B });
    expect(counts).toMatchObject({ scanned: 2, patched: 1, skipped: 1 });
  });

  it("writes each document to its OWN ref", async () => {
    // The copy-paste bug the phase doc names: paging one collection while writing
    // to another. Both documents landing on one ref is the observable symptom.
    withPages([page([{ createdBy: "uid-a" }, { createdBy: "uid-b" }])]);

    await backfillCollection("ideas", MAP);

    const refs = bulkWriterSet.mock.calls.map((c) => c[0].path);
    expect(new Set(refs).size).toBe(2);
    expect(refs).toEqual(["ideas/doc-0", "ideas/doc-1"]);
  });

  it("writes nothing at all in dry-run, but still reports what it would do", async () => {
    withPages([page([{ createdBy: "uid-a" }, { createdBy: "" }])]);

    const counts = await backfillCollection("ideas", MAP, { dryRun: true });

    expect(bulkWriterSet).not.toHaveBeenCalled();
    expect(progressSet).not.toHaveBeenCalled();
    expect(counts).toMatchObject({ scanned: 2, patched: 2, orphaned: 1 });
  });

  it("resumes from the stored cursor rather than rescanning from the start", async () => {
    progressGet.mockResolvedValue({ get: (f: string) => (f === "lastCursor" ? "doc-499" : undefined) });
    const startAfter = jest.fn();
    collectionFn.mockImplementation((name: string) => {
      if (name === "migrations") return { doc: () => ({ get: progressGet, set: progressSet }) };
      const query: Record<string, unknown> = {
        orderBy: () => query,
        limit: () => query,
        startAfter: (c: string) => {
          startAfter(c);
          return query;
        },
        get: async () => page([]),
      };
      return query;
    });

    await backfillCollection("ideas", MAP);

    expect(startAfter).toHaveBeenCalledWith("doc-499");
  });

  it("records a cursor after each page so an interrupted run can continue", async () => {
    withPages([page([{ createdBy: "uid-a" }])]);

    await backfillCollection("ideas", MAP);

    const cursorWrite = progressSet.mock.calls.find((c) => "lastCursor" in c[0]);
    expect(cursorWrite![0].lastCursor).toBe("doc-0");
    expect(cursorWrite![1]).toEqual({ merge: true });
  });

  it("stamps completedAt — the only durable answer to 'is the backfill done?'", async () => {
    withPages([page([{ createdBy: "uid-a" }])]);

    await backfillCollection("ideas", MAP);

    const done = progressSet.mock.calls.find((c) => c[0].completedAt === "server-ts");
    expect(done).toBeDefined();
  });
});

describe("the verification pass — asserts the value, not the field's presence", () => {
  it.each([
    ["the correctly mapped account", { createdBy: "uid-a", accountId: ACC_A }, "matched"],
    ["ANOTHER user's account", { createdBy: "uid-a", accountId: ACC_B }, "mismatched"],
    ["a uid left in the account slot", { createdBy: "uid-a", accountId: "uid-a" }, "mismatched"],
    ["a quarantined record", { createdBy: "", accountId: ORPHAN }, "orphaned"],
    ["no accountId at all", { createdBy: "uid-a" }, "missing"],
    ["an empty-string accountId", { createdBy: "uid-a", accountId: "" }, "missing"],
  ])("reports %s as %s", (_label, data, expected) => {
    expect(verifyDoc(data, MAP)).toBe(expected);
  });

  it("counts a wrong-but-present accountId as a failure, not a pass", async () => {
    // A presence check passes this document. It is one user's record tagged with
    // another user's account — the outcome the whole migration exists to prevent.
    withPages([page([{ createdBy: "uid-a", accountId: ACC_B }])]);

    const v = await verifyCollection("ideas", MAP);

    expect(v).toMatchObject({ scanned: 1, matched: 0, mismatched: 1 });
  });

  it("does not let orphans pass as matched — they are truthy", async () => {
    withPages([page([{ createdBy: "", accountId: ORPHAN }])]);

    const v = await verifyCollection("ideas", MAP);

    expect(v).toMatchObject({ matched: 0, orphaned: 1, mismatched: 0 });
  });

  it("reports a clean collection as fully matched", async () => {
    withPages([page([{ createdBy: "uid-a", accountId: ACC_A }, { createdBy: "uid-b", accountId: ACC_B }])]);

    const v = await verifyCollection("ideas", MAP);

    expect(v).toMatchObject({ scanned: 2, matched: 2, mismatched: 0, missing: 0, orphaned: 0 });
  });
});

describe("scope", () => {
  it("covers the five real collections and deliberately excludes events", () => {
    // `events` is append-only telemetry nothing reads; new ones carry accountId
    // from Phase 03. Including it would be the largest scan in the job for no
    // benefit. Dropping any of the other five silently leaves records behind.
    expect([...BACKFILL_COLLECTIONS]).toEqual([
      "ideas",
      "scripts",
      "hooks",
      "packaging",
      "videoProjects",
    ]);
    expect([...BACKFILL_COLLECTIONS]).not.toContain("events");
    expect([...BACKFILL_COLLECTIONS]).not.toContain("users");
  });

  it("refuses a --collection= that is not one of the five", () => {
    // The value went straight to db.collection(). `--collection=users` would
    // scan the users collection, find no createdBy on anything, and stamp
    // `accountId: "__orphan"` across every user document — a destructive write
    // reachable by one plausible typo, on a script run by hand against
    // production.
    expect(() => pickCollections("users")).toThrow(/--collection must be one of/);
    expect(() => pickCollections("idea")).toThrow(/--collection must be one of/);
    expect(() => pickCollections("events")).toThrow(/--collection must be one of/);
  });

  it("accepts a real one, and defaults to all five", () => {
    expect(pickCollections("packaging")).toEqual(["packaging"]);
    expect(pickCollections()).toEqual([...BACKFILL_COLLECTIONS]);
  });
});
