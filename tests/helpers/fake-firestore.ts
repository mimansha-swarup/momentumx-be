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
      return actual !== f.value;
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

  private col(name: string): Map<string, Doc> {
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
    return new FakeQuery(this.col(name), name);
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
    private store: Map<string, Doc>,
    readonly id: string,
    readonly path: string
  ) {}

  setSync(data: Doc, opts?: { merge?: boolean }) {
    const prior = opts?.merge ? (this.store.get(this.id) ?? {}) : {};
    // Dotted keys in an update patch address nested fields, exactly as Firestore
    // treats them — a plain spread would create a literal "a.b" key instead.
    this.store.set(this.id, applyPatch({ ...prior }, data));
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
    // Sub-collections are flattened; nothing under test queries across them.
    return new FakeQuery(new Map(), `${this.path}/${name}`);
  }
}

const applyPatch = (base: Doc, patch: Doc): Doc => {
  for (const [k, v] of Object.entries(patch)) {
    if (!k.includes(".")) {
      base[k] = v;
      continue;
    }
    const parts = k.split(".");
    let cur = base;
    for (const part of parts.slice(0, -1)) {
      cur[part] = { ...((cur[part] as Doc) ?? {}) };
      cur = cur[part] as Doc;
    }
    cur[parts[parts.length - 1]] = v;
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
    private store: Map<string, Doc>,
    private name: string
  ) {}

  private clone(): FakeQuery {
    const q = new FakeQuery(this.store, this.name);
    q.filters = [...this.filters];
    q.orders = [...this.orders];
    q.cap = this.cap;
    q.projection = this.projection;
    q.after = this.after;
    return q;
  }

  doc(id?: string) {
    const key = id ?? `auto-${this.store.size + 1}`;
    return new FakeDocRef(this.store, key, `${this.name}/${key}`);
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
      const [cursor] = this.after;
      const key = this.orders[0]?.field ?? "__name__";
      const idx = rows.findIndex(({ id, d }) =>
        key === "__name__" ? id === cursor : at(d, key) === cursor
      );
      if (idx >= 0) rows = rows.slice(idx + 1);
    }

    if (this.cap !== undefined) rows = rows.slice(0, this.cap);

    const docs = rows.map(({ id, d }) => {
      const data = this.projection
        ? Object.fromEntries(this.projection.filter((f) => f in d).map((f) => [f, d[f]]))
        : d;
      return snap(id, data, new FakeDocRef(this.store, id, `${this.name}/${id}`));
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
          increment: (n: number) => n,
          delete: () => undefined,
        },
        // Repositories reach for this off `firebase.firestore` as well as the
        // named import; the query treats the sentinel as the document id.
        FieldPath: { documentId: () => ({ __name__: "__name__" }) },
      },
    },
  };
};
