/**
 * An in-memory Firestore that actually applies `where`.
 *
 * Every other suite in this repo mocks `db.collection()` with a jest.fn chain, so
 * a query's FILTERS are never evaluated — the mock returns whatever the test
 * queued regardless of what was asked for. That is fine for testing an `if`, and
 * useless for testing tenancy: a repository that filters the wrong field, or
 * drops the filter entirely, returns exactly the same rows through a chain mock.
 *
 * Phase 06 moved every list query from `createdBy` to `accountId`, so "which
 * documents come back" is now the thing most worth asserting. This fake exists
 * for that one job and is deliberately small: equality filters, ordering, limit,
 * field projection, point reads, and batched writes — which is the whole surface
 * the repositories use. It is NOT a Firestore emulator and knows nothing about
 * indexes, so it cannot tell you a composite index is missing.
 *
 * Injected the same way every suite already injects a mock db:
 *
 *   jest.mock("../../src/config/firebase", () => require("../helpers/fake-firestore").mockFirebase());
 */

type Doc = Record<string, unknown>;
type Filter = { field: string; op: string; value: unknown };

const at = (data: Doc, path: string): unknown =>
  path.split(".").reduce<unknown>((acc, k) => (acc as Doc)?.[k], data);

/** Timestamps, Dates and numbers all have to be comparable for orderBy. */
const ms = (v: unknown): number => {
  if (v == null) return 0;
  if (typeof v === "number") return v;
  if (typeof (v as { toMillis?: () => number }).toMillis === "function") {
    return (v as { toMillis: () => number }).toMillis();
  }
  if (v instanceof Date) return v.getTime();
  const parsed = Date.parse(String(v));
  return Number.isNaN(parsed) ? 0 : parsed;
};

const matches = (data: Doc, f: Filter): boolean => {
  const actual = at(data, f.field);
  switch (f.op) {
    case "==":
      return actual === f.value;
    case "!=":
      // Real Firestore EXCLUDES documents where the field is absent: `!=` is
      // "has this field, and it differs". `undefined !== false` is true in JS,
      // so the naive version returned every legacy document that predates the
      // field — the opposite answer on exactly the documents a migration cares
      // about.
      return actual !== undefined && actual !== f.value;
    case "array-contains":
      return Array.isArray(actual) && actual.includes(f.value);
    case "in":
      return Array.isArray(f.value) && (f.value as unknown[]).includes(actual);
    default:
      throw new Error(`fake-firestore: unsupported operator "${f.op}"`);
  }
};

export class FakeFirestore {
  /** collection → id → document. Public so tests can seed and assert directly. */
  readonly data = new Map<string, Map<string, Doc>>();

  /**
   * Collections are keyed by their FULL path, so `accounts/{id}/context` is just
   * another entry. That is what makes sub-collections behave: a doc ref resolves
   * its children through here rather than owning a detached map, which is how an
   * earlier version silently dropped every sub-collection write.
   */
  col(name: string): Map<string, Doc> {
    if (!this.data.has(name)) this.data.set(name, new Map());
    return this.data.get(name)!;
  }

  /** Seed a collection. Each document must carry its own `id`. */
  seed(collection: string, docs: Doc[]): this {
    docs.forEach((d) => this.col(collection).set(String(d.id), { ...d }));
    return this;
  }

  all(collection: string): Doc[] {
    return [...this.col(collection).values()];
  }

  collection(name: string) {
    return new FakeQuery(this, name);
  }

  private autoId = 0;

  nextAutoId(): string {
    this.autoId += 1;
    return `auto-${this.autoId}`;
  }

  batch() {
    const ops: (() => void)[] = [];
    return {
      set: (ref: FakeDocRef, data: Doc, opts?: { merge?: boolean }) =>
        ops.push(() => ref.setSync(data, opts)),
      update: (ref: FakeDocRef, data: Doc) => ops.push(() => ref.updateSync(data)),
      delete: (ref: FakeDocRef) => ops.push(() => ref.deleteSync()),
      commit: async () => ops.forEach((op) => op()),
    };
  }

  async runTransaction<T>(fn: (txn: FakeTxn) => Promise<T>): Promise<T> {
    // Serial, not concurrent. This fake cannot test contention — it exists to
    // test what a transaction READS and WRITES, not that it retries.
    const ops: (() => void)[] = [];
    const txn: FakeTxn = {
      // Both a doc ref and a query answer `get()`, so there is nothing to branch
      // on — `txn.get` is used with each and the union already covers it.
      get: async (target: FakeDocRef | FakeQuery) => target.get(),
      set: (ref, data, opts) => ops.push(() => ref.setSync(data, opts)),
      update: (ref, data) => ops.push(() => ref.updateSync(data)),
      delete: (ref) => ops.push(() => ref.deleteSync()),
    };
    const out = await fn(txn);
    ops.forEach((op) => op());
    return out;
  }
}

export interface FakeTxn {
  get(target: FakeDocRef | FakeQuery): Promise<unknown>;
  set(ref: FakeDocRef, data: Doc, opts?: { merge?: boolean }): void;
  update(ref: FakeDocRef, data: Doc): void;
  delete(ref: FakeDocRef): void;
}

class FakeDocRef {
  constructor(
    private owner: FakeFirestore,
    private collectionPath: string,
    readonly id: string,
    readonly path: string
  ) {}

  private get store(): Map<string, Doc> {
    return this.owner.col(this.collectionPath);
  }

  /**
   * `set()` — and a dotted key here is a LITERAL FIELD NAME, not a path.
   *
   * Only `update()` treats `"a.b"` as `a → b`; `set()` writes a top-level field
   * called `"a.b"`. This routed through `applyPatch` and so gave `set()` update
   * semantics — hiding the exact trap `src/repository/user.repository.ts` spends
   * twelve comment lines on, and blessing any future `set(dotted, {merge:true})`
   * call site that production would silently write wrong.
   *
   * `merge` deep-merges nested maps, which is what Firestore does; the previous
   * shallow `base[k] = v` dropped sibling keys inside `itemStatuses` and
   * `pipeline` while the test asserting the new map still passed.
   */
  setSync(data: Doc, opts?: { merge?: boolean }) {
    if (!opts?.merge) {
      const fresh: Doc = {};
      for (const [k, v] of Object.entries(data)) {
        const resolved = resolveValue(undefined, v);
        if (resolved === DELETE_KEY) {
          // Real Firestore REJECTS this: "FieldValue.delete() can only be used
          // with update() and set() with {merge:true}". Silently dropping the
          // key made the fake more permissive than production, so code that
          // throws in production passed here.
          throw new Error(
            "fake-firestore: FieldValue.delete() requires update() or set({merge:true})"
          );
        }
        fresh[k] = resolved;
      }
      this.store.set(this.id, fresh);
      return;
    }
    this.store.set(this.id, deepMerge({ ...(this.store.get(this.id) ?? {}) }, data));
  }

  updateSync(data: Doc) {
    if (!this.store.has(this.id)) throw new Error(`NOT_FOUND: ${this.path}`);
    this.store.set(this.id, applyPatch({ ...this.store.get(this.id)! }, data));
  }

  deleteSync() {
    this.store.delete(this.id);
  }

  async set(data: Doc, opts?: { merge?: boolean }) {
    this.setSync(data, opts);
  }

  async update(data: Doc) {
    this.updateSync(data);
  }

  async delete() {
    this.deleteSync();
  }

  async get() {
    const data = this.store.get(this.id);
    return snap(this.id, data, this);
  }

  collection(name: string) {
    return new FakeQuery(this.owner, `${this.path}/${name}`);
  }
}

/** A `FieldValue` stand-in. Tagged so a write can resolve it against what is stored. */
type Sentinel = { __fv: "increment"; by: number } | { __fv: "delete" };

const isSentinel = (v: unknown): v is Sentinel =>
  typeof v === "object" && v !== null && "__fv" in (v as Record<string, unknown>);

const isPlainObject = (v: unknown): v is Doc =>
  typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof Date);

/**
 * Resolve one field's incoming value against what is already there.
 *
 * `FieldValue.increment(n)` used to be modelled as the number `n`, which turns
 * an increment into a SET: call it twice with 10 and the fake reads 10 while
 * production reads 20. Every counter assertion was checking the wrong
 * arithmetic. `FieldValue.delete()` was `undefined`, which leaves the key in
 * place — so `"field" in doc` stayed true and `select()` projections diverged.
 */
const resolveValue = (existing: unknown, incoming: unknown): unknown => {
  if (isSentinel(incoming)) {
    if (incoming.__fv === "increment") {
      return (typeof existing === "number" ? existing : 0) + incoming.by;
    }
    return DELETE_KEY;
  }
  return incoming;
};

const DELETE_KEY = Symbol("fake-firestore.delete");

/** Firestore merges nested MAPS recursively; it does not replace them. */
const deepMerge = (base: Doc, patch: Doc): Doc => {
  for (const [k, v] of Object.entries(patch)) {
    const resolved = resolveValue(base[k], v);
    if (resolved === DELETE_KEY) {
      delete base[k];
    } else if (isPlainObject(resolved) && isPlainObject(base[k])) {
      base[k] = deepMerge({ ...(base[k] as Doc) }, resolved);
    } else {
      base[k] = resolved;
    }
  }
  return base;
};

/**
 * `update()` semantics: a dotted key addresses a NESTED FIELD.
 *
 * This is the half that was right. The half that was not is that `setSync` also
 * routed through here — see `FakeDocRef.setSync`.
 */
const applyPatch = (base: Doc, patch: Doc): Doc => {
  for (const [k, v] of Object.entries(patch)) {
    if (!k.includes(".")) {
      const resolved = resolveValue(base[k], v);
      if (resolved === DELETE_KEY) delete base[k];
      else base[k] = resolved;
      continue;
    }
    const parts = k.split(".");
    let cur = base;
    for (const part of parts.slice(0, -1)) {
      cur[part] = { ...((cur[part] as Doc) ?? {}) };
      cur = cur[part] as Doc;
    }
    const leaf = parts[parts.length - 1];
    const resolved = resolveValue(cur[leaf], v);
    if (resolved === DELETE_KEY) delete cur[leaf];
    else cur[leaf] = resolved;
  }
  return base;
};

const snap = (id: string, data: Doc | undefined, ref: unknown) => ({
  id,
  ref,
  exists: data !== undefined,
  data: () => (data ? { ...data } : undefined),
  get: (field: string) => (data ? at(data, field) : undefined),
});

class FakeQuery {
  private filters: Filter[] = [];
  private orders: { field: string; dir: string }[] = [];
  private cap?: number;
  private projection?: string[];
  private after?: unknown[];

  constructor(
    private owner: FakeFirestore,
    private name: string
  ) {}

  private get store(): Map<string, Doc> {
    return this.owner.col(this.name);
  }

  private clone(): FakeQuery {
    const q = new FakeQuery(this.owner, this.name);
    q.filters = [...this.filters];
    q.orders = [...this.orders];
    q.cap = this.cap;
    q.projection = this.projection;
    q.after = this.after;
    return q;
  }

  doc(id?: string) {
    // Was `auto-${store.size + 1}`, so two unsaved refs got the SAME id and ids
    // were reused after a delete — a later write silently overwrote an earlier
    // document. Monotonic per fake, like a real auto-id.
    const key = id ?? this.owner.nextAutoId();
    return new FakeDocRef(this.owner, this.name, key, `${this.name}/${key}`);
  }

  /**
   * The `count()` aggregation, which `projectCount` uses on every channel in the
   * switcher. Modelled because the alternative — reading whole project documents
   * and taking `.length` — is precisely the thing the repository avoids, and a
   * fake that only supported `get()` would quietly bless it.
   */
  count() {
    return {
      get: async () => {
        const { size } = await this.get();
        return { data: () => ({ count: size }) };
      },
    };
  }

  where(field: unknown, op: string, value: unknown) {
    const q = this.clone();
    // FieldPath.documentId() arrives as a sentinel object, not a string.
    const name =
      typeof field === "string" ? field : (field as { __name__?: string })?.__name__ ?? "__name__";
    q.filters.push({ field: name, op, value });
    return q;
  }

  orderBy(field: unknown, dir = "asc") {
    const q = this.clone();
    const name = typeof field === "string" ? field : "__name__";
    q.orders.push({ field: name, dir });
    return q;
  }

  limit(n: number) {
    const q = this.clone();
    q.cap = n;
    return q;
  }

  select(...fields: string[]) {
    const q = this.clone();
    q.projection = fields;
    return q;
  }

  startAfter(...values: unknown[]) {
    const q = this.clone();
    q.after = values;
    return q;
  }

  async get() {
    let rows = [...this.store.entries()].map(([id, d]) => ({ id, d }));

    for (const f of this.filters) {
      rows = rows.filter(({ id, d }) =>
        f.field === "__name__" ? matches({ __name__: id }, f) : matches(d, f)
      );
    }

    // Real Firestore DROPS documents that lack the ordering field — they are
    // absent from the index it sorts on, so they are absent from the result.
    // Including them (`ms(undefined) === 0`, sorted to the front) meant a
    // repository that stopped writing `updatedAt` still listed its documents
    // here while production showed the user an empty dashboard.
    for (const o of this.orders) {
      if (o.field === "__name__") continue;
      rows = rows.filter(({ d }) => at(d, o.field) !== undefined);
    }

    for (const o of [...this.orders].reverse()) {
      rows.sort((a, b) => {
        const av = o.field === "__name__" ? a.id : at(a.d, o.field);
        const bv = o.field === "__name__" ? b.id : at(b.d, o.field);
        const cmp =
          typeof av === "string" && typeof bv === "string"
            ? av.localeCompare(bv)
            : ms(av) - ms(bv);
        return o.dir === "desc" ? -cmp : cmp;
      });
    }

    if (this.after?.length) {
      /**
       * Firestore positions a cursor by the ORDERED FIELD VALUES, and keeps
       * every row that sorts strictly after them. It does NOT require the
       * cursor document to be in the result set.
       *
       * Two bugs lived here. First the lookup compared a `DocumentSnapshot` to a
       * field value with `===`, so it always missed and the fake returned the
       * UNSLICED list — a broken cursor read as a working one. The fix for that
       * matched the snapshot by `id` and THREW when no row matched, which is
       * wrong in a new direction: `video-project.repository.list` filters
       * `isDeleted == false`, so a project soft-deleted between page 1 and
       * "load more" is a cursor that is legitimately absent from the result —
       * real Firestore pages on, this fake blew up.
       *
       * Second, only `after[0]` was read. `content.repository.getIdeas` passes
       * TWO values (`title`, then `docId`) precisely because two ideas can share
       * a title and a single-value cursor skips every duplicate after the first.
       * Dropping the tie-breaker was invisible to any test written against this.
       *
       * So: build the cursor's ordered values — from the snapshot's data, or
       * from the raw values as given — and compare lexicographically against
       * each row's, honouring each order's direction.
       */
      const asSnapshot = this.after[0] as { id?: string; data?: () => Doc } | undefined;
      const fromSnapshot =
        this.after.length === 1 &&
        asSnapshot != null &&
        typeof asSnapshot.data === "function";

      const orders = this.orders.length ? this.orders : [{ field: "__name__", dir: "asc" }];
      const cursorValues = fromSnapshot
        ? orders.map((o) =>
            o.field === "__name__" ? asSnapshot!.id : at(asSnapshot!.data!(), o.field)
          )
        : this.after;

      const compare = (rowValues: unknown[]): number => {
        for (let i = 0; i < cursorValues.length; i++) {
          const a = rowValues[i];
          const b = cursorValues[i];
          if (a === b) continue;
          const cmp =
            typeof a === "string" && typeof b === "string"
              ? a.localeCompare(b)
              : ms(a) - ms(b);
          if (cmp !== 0) return orders[i]?.dir === "desc" ? -cmp : cmp;
        }
        return 0;
      };

      rows = rows.filter(({ id, d }) =>
        compare(orders.map((o) => (o.field === "__name__" ? id : at(d, o.field)))) > 0
      );
    }

    if (this.cap !== undefined) rows = rows.slice(0, this.cap);

    const docs = rows.map(({ id, d }) => {
      const data = this.projection
        ? Object.fromEntries(this.projection.filter((f) => f in d).map((f) => [f, d[f]]))
        : d;
      return snap(id, data, new FakeDocRef(this.owner, this.name, id, `${this.name}/${id}`));
    });

    return { empty: docs.length === 0, size: docs.length, docs };
  }
}

/**
 * A `src/config/firebase` replacement backed by one FakeFirestore.
 *
 * The instance is reachable as `require(...).__db` so a suite can seed it after
 * `jest.mock` has hoisted.
 */
export const mockFirebase = () => {
  const store = new FakeFirestore();
  return {
    __db: store,
    db: store,
    firebase: {
      firestore: {
        FieldValue: {
          serverTimestamp: () => Date.now(),
          // Tagged, then resolved against what is stored at write time — see
          // `resolveValue`. Returning the raw number made every increment a set.
          increment: (n: number) => ({ __fv: "increment", by: n }),
          delete: () => ({ __fv: "delete" }),
        },
        // Repositories reach for this off `firebase.firestore` as well as the
        // named import; the query treats the sentinel as the document id.
        FieldPath: { documentId: () => ({ __name__: "__name__" }) },
      },
    },
  };
};
