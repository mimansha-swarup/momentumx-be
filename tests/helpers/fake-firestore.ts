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

/**
 * Firestore orders strings by UTF-8 byte order, not locale collation. The
 * SDK's own local comparator (`order.js:79-85`'s `primitiveComparator`, used
 * for `stringValue` at `order.js:241`) does this with plain `<`/`>` on the JS
 * string — not `Buffer`, not `localeCompare` — so that is what the fake
 * mirrors. `localeCompare("a", "é")` sorts them adjacent (locale collation);
 * byte/codepoint order does not — `"Z" < "a" < "é"` (0x5A, 0x61, 0xE9), so a
 * mixed-case, mixed-script sort was silently reordering the result relative
 * to what production returns.
 */
const compareStrings = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The one comparator every ordered/ranged codepath shares — the sort loop,
 * the cursor-bound compare, and the range operators below — so a sort and a
 * range filter can never disagree about which value is larger. Strings go
 * through `compareStrings` (byte/codepoint order, not locale collation);
 * everything else (numbers, Dates, and Timestamp-likes via `ms`'s existing
 * `toMillis` check — no second detector needed) goes through `ms`.
 */
const compareOrdered = (a: unknown, b: unknown): number =>
  typeof a === "string" && typeof b === "string" ? compareStrings(a, b) : ms(a) - ms(b);

const RANGE_OPS = [">", ">=", "<", "<="] as const;

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
    case ">":
    case ">=":
    case "<":
    case "<=":
      /**
       * A range/inequality filter requires the field to exist, same as `!=`
       * above: `getInequalityFilterFields()` (query.js:463-476) and
       * `createImplicitOrderBy` (query.js:497-517) both treat an inequality
       * filter's field exactly like an explicit `orderBy` field — and this
       * fake's own `orderBy` already drops documents that lack the ordering
       * field for the same reason (Firestore has nothing indexed to compare
       * against). A document missing the field is excluded outright, never
       * treated as `null` or `0`.
       */
      if (actual === undefined) return false;
      {
        const cmp = compareOrdered(actual, f.value);
        if (f.op === ">") return cmp > 0;
        if (f.op === ">=") return cmp >= 0;
        if (f.op === "<") return cmp < 0;
        return cmp <= 0;
      }
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

  /**
   * Snapshot / restore the whole store, so a commit can be all-or-nothing.
   *
   * Firestore never produces a partial commit. Applying staged writes one at a time
   * does, the moment one of them throws, and a test that then asserts on the store is
   * reading a state production cannot reach.
   *
   * Documents are cloned one level deep, which is all the fake's writers mutate.
   */
  private snapshotStore(): Map<string, Map<string, Doc>> {
    const copy = new Map<string, Map<string, Doc>>();
    for (const [name, docs] of this.data) {
      copy.set(name, new Map([...docs].map(([id, doc]) => [id, { ...doc }])));
    }
    return copy;
  }

  private restoreStore(snapshot: Map<string, Map<string, Doc>>): void {
    this.data.clear();
    for (const [name, docs] of snapshot) this.data.set(name, docs);
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
      create: (ref: FakeDocRef, data: Doc) => ops.push(() => ref.createSync(data)),
      update: (ref: FakeDocRef, data: Doc) => ops.push(() => ref.updateSync(data)),
      delete: (ref: FakeDocRef) => ops.push(() => ref.deleteSync()),
      // All-or-nothing. This was `ops.forEach((op) => op())`, so an op that threw
      // partway left every earlier write applied — a partial commit, which Firestore
      // never produces. Snapshot and roll back instead.
      commit: async () => {
        const rollback = this.snapshotStore();
        try {
          ops.forEach((op) => op());
        } catch (error) {
          this.restoreStore(rollback);
          throw error;
        }
      },
    };
  }

  async runTransaction<T>(fn: (txn: FakeTxn) => Promise<T>): Promise<T> {
    // Serial, not concurrent. This fake cannot test contention — it exists to
    // test what a transaction READS and WRITES, not that it retries.
    const ops: (() => void)[] = [];
    // Firestore REJECTS a read issued after the first write in a transaction
    // ("Firestore transactions require all reads to be executed before all
    // writes"). A fake that allows it blesses a repository that production
    // refuses at runtime, so the write path records it and the read path throws.
    let wrote = false;
    const write = (op: () => void) => {
      wrote = true;
      ops.push(op);
    };
    const txn: FakeTxn = {
      // Both a doc ref and a query answer `get()`, so there is nothing to branch
      // on — `txn.get` is used with each and the union already covers it.
      get: async (target: FakeDocRef | FakeQuery) => {
        if (wrote) {
          throw new Error(
            "fake-firestore: Firestore transactions require all reads to be executed before all writes"
          );
        }
        return target.get();
      },
      set: (ref, data, opts) => write(() => ref.setSync(data, opts)),
      create: (ref, data) => write(() => ref.createSync(data)),
      update: (ref, data) => write(() => ref.updateSync(data)),
      delete: (ref) => write(() => ref.deleteSync()),
    };
    const out = await fn(txn);
    // All-or-nothing, same as `batch().commit()`. Applying staged writes one at a time
    // left every predecessor applied when one threw — a partial commit, which Firestore
    // never produces, so a test asserting on the store read an unreachable state.
    const rollback = this.snapshotStore();
    try {
      ops.forEach((op) => op());
    } catch (error) {
      this.restoreStore(rollback);
      throw error;
    }
    return out;
  }
}

export interface FakeTxn {
  get(target: FakeDocRef | FakeQuery): Promise<unknown>;
  set(ref: FakeDocRef, data: Doc, opts?: { merge?: boolean }): void;
  create(ref: FakeDocRef, data: Doc): void;
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

  /**
   * `create()` is `set()` PLUS a server-enforced `Precondition({exists:
   * false})` (`write-batch.js:152-160`) — the backend refuses with
   * `ALREADY_EXISTS` if the document is already there, which is the entire
   * reason a repository reaches for `create` over `set` in the first place.
   * A fake that silently aliased `create` to `set` (as a workaround test file
   * had to, absent this) passed a "reject the duplicate" test that production
   * would fail. Mirrors this file's own `NOT_FOUND:` convention in
   * `updateSync` for the opposite case.
   */
  createSync(data: Doc) {
    if (this.store.has(this.id)) throw new Error(`ALREADY_EXISTS: ${this.path}`);
    this.setSync(data);
  }

  deleteSync() {
    this.store.delete(this.id);
  }

  async set(data: Doc, opts?: { merge?: boolean }) {
    this.setSync(data, opts);
  }

  async create(data: Doc) {
    this.createSync(data);
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
type Sentinel =
  | { __fv: "increment"; by: number }
  | { __fv: "delete" }
  | { __fv: "serverTimestamp" };

/**
 * A `Timestamp` stand-in. `server: true` marks one the SERVER minted, which is
 * the only way a test can tell `FieldValue.serverTimestamp()` apart from a
 * client-side `new Date()` / `Date.now()` after the write has landed — the
 * distinction `firestore-conventions.md` makes non-negotiable for stored fields.
 */
export const fakeTimestamp = (millis: number, server = false) => ({
  seconds: Math.floor(millis / 1000),
  nanoseconds: Math.floor((millis % 1000) * 1_000_000),
  __server: server,
  toMillis: () => millis,
  toDate: () => new Date(millis),
  isEqual: (other: unknown) =>
    typeof (other as { toMillis?: () => number })?.toMillis === "function" &&
    (other as { toMillis: () => number }).toMillis() === millis,
});

/** Did this stored value come from `FieldValue.serverTimestamp()`? */
export const isServerTimestamp = (v: unknown): boolean =>
  typeof (v as { toMillis?: () => number })?.toMillis === "function" &&
  (v as { __server?: boolean }).__server === true;

const isSentinel = (v: unknown): v is Sentinel =>
  typeof v === "object" && v !== null && "__fv" in (v as Record<string, unknown>);

/**
 * A timestamp is a VALUE, not a map to recurse into.
 *
 * A real `firebase-admin` Timestamp carries `toMillis`/`toDate` on its PROTOTYPE, so
 * rebuilding it with `Object.entries` produced `{ _seconds, _nanoseconds }` with no
 * methods — and any repository calling `.toDate()` on what it read back crashed, or
 * worse, silently compared undefined. The fake's own timestamps survived the same
 * treatment because their methods are own enumerable properties, which is exactly why
 * this never showed up in a test.
 */
const isTimestampLike = (v: unknown): boolean =>
  typeof (v as { toMillis?: () => number })?.toMillis === "function" ||
  typeof (v as { toDate?: () => Date })?.toDate === "function";

const isPlainObject = (v: unknown): v is Doc =>
  typeof v === "object" &&
  v !== null &&
  !Array.isArray(v) &&
  !(v instanceof Date) &&
  !isTimestampLike(v);

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
    // Resolved AT WRITE TIME into a Timestamp, exactly as the server does — so a
    // field written with serverTimestamp() reads back with `.toDate()` (the
    // repositories call it) instead of being a bare number that crashes them.
    if (incoming.__fv === "serverTimestamp") return fakeTimestamp(Date.now(), true);
    return DELETE_KEY;
  }
  /**
   * Firestore resolves a sentinel WHEREVER it appears, including nested inside a
   * map field. `billing.repository.reserve` writes
   * `{ generationLocks: { [key]: { token, startedAt: serverTimestamp() } } }`,
   * so resolving only the top level left `startedAt` as the tagged object —
   * `lockAge` then read it as 0 and every in-flight generation lock looked
   * infinitely old, silently disabling the guard this fake is used to test.
   */
  if (isPlainObject(incoming)) {
    const entries = Object.entries(incoming).map(
      ([k, v]) => [k, resolveValue((existing as Doc | undefined)?.[k], v)] as const
    );
    /**
     * This recursive branch is only reached from `update()` (via `applyPatch`)
     * and plain `set()` (via `setSync`'s non-merge branch) — `set(..., {merge:
     * true})` recurses in `deepMerge` itself and resolves a nested delete as a
     * LEAF (see `deepMerge`), so it never lands here at all.
     *
     * For `update()`, a `FieldValue.delete()` nested inside a plain-object
     * VALUE is genuinely illegal: `write-batch.js`'s `validateUpdateMap` calls
     * `validateFieldValue` with `allowDeletes: 'root'`, and `serializer.js`'s
     * `validateUserInput` only allows a `DeleteTransform` at `level === 0`
     * (`update({ field: FieldValue.delete() })`) or `level === 1` with a
     * single-segment path (the dotted-key form,
     * `update({ "a.b": FieldValue.delete() })` — `FieldPath.fromArgument`
     * splits the dots into one path of size 2, but `validateUpdateMap`'s own
     * per-key recursion sees the RAW key "a.b" as one unsplit segment, so it
     * is still level 1 there). A delete found deeper than that — i.e. nested
     * inside an actual sub-object like `update({ a: { b: FieldValue.delete() }
     * })` — throws in production, so refuse it loudly here too rather than
     * silently keeping the field.
     */
    const nested = entries.find(([, v]) => v === DELETE_KEY);
    if (nested) {
      throw new Error(
        `fake-firestore: FieldValue.delete() nested inside a map field ("${nested[0]}") is not modelled. ` +
          `Use a dotted path instead: update({ "parent.${nested[0]}": FieldValue.delete() }).`
      );
    }
    return Object.fromEntries(entries);
  }
  return incoming;
};

const DELETE_KEY = Symbol("fake-firestore.delete");

/**
 * Firestore merges nested MAPS recursively; it does not replace them.
 *
 * `set(..., {merge: true})` also allows `FieldValue.delete()` at ANY depth —
 * `write-batch.js:263-264` passes `allowDeletes: !!(mergePaths || mergeLeaves)`
 * into `validateDocumentData`, which maps a truthy value to `'all'`
 * (`write-batch.js:610`), and `serializer.js`'s `validateUserInput` only
 * refuses a `DeleteTransform` for `'none'` or (at the wrong level) `'root'` —
 * `'all'` hits neither branch, so it is never refused.
 *
 * Recursing into a plain-object PATCH value before resolving it (rather than
 * asking `resolveValue` to resolve the whole nested object in one shot, the
 * way `applyPatch` does for `update()`) is what makes that legal: each nested
 * delete then reaches this same per-key branch as a LEAF, exactly like a
 * top-level one, so `delete base[k]` fires at the depth it actually occurs
 * at instead of `resolveValue` throwing partway through a deep object it
 * cannot partially return from.
 */
const deepMerge = (base: Doc, patch: Doc): Doc => {
  for (const [k, v] of Object.entries(patch)) {
    if (!isSentinel(v) && isPlainObject(v)) {
      const existing = isPlainObject(base[k]) ? (base[k] as Doc) : {};
      base[k] = deepMerge({ ...existing }, v);
      continue;
    }
    const resolved = resolveValue(base[k], v);
    if (resolved === DELETE_KEY) {
      delete base[k];
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

/**
 * `.data()` must hand back an INDEPENDENT copy. Real Firestore deserialises a
 * fresh object from its wire format on every call; nothing a caller does to
 * the returned object can reach the database without a `set`/`update`. A
 * shallow `{ ...data }` copies only the top level — every NESTED object or
 * array is still the exact reference held in the store, so mutating a nested
 * field on a "read" silently corrupts the document no write ever touched.
 * That aliasing let two transactions that both read the same doc share one
 * `members` object between them.
 *
 * A Timestamp-like is a VALUE, not a map to recurse into (same reasoning as
 * `isPlainObject` excluding it above): it's immutable, so sharing the
 * reference is correct, and `isPlainObject` already routes it away from the
 * recursive branch — no second detector needed.
 */
const deepClone = <T>(v: T): T => {
  if (Array.isArray(v)) return v.map((x) => deepClone(x)) as unknown as T;
  if (isPlainObject(v)) {
    return Object.fromEntries(Object.entries(v).map(([k, val]) => [k, deepClone(val)])) as T;
  }
  return v;
};

const snap = (id: string, data: Doc | undefined, ref: unknown) => ({
  id,
  ref,
  exists: data !== undefined,
  data: () => (data ? deepClone(data) : undefined),
  // Same aliasing risk as `.data()` above, one level narrower: `at()` can
  // return a nested object/array reference straight out of the store.
  get: (field: string) => (data ? deepClone(at(data, field)) : undefined),
});

class FakeQuery {
  private filters: Filter[] = [];
  private orders: { field: string; dir: string }[] = [];
  private cap?: number;
  private projection?: string[];
  private bounds: {
    kind: "startAt" | "startAfter" | "endAt";
    values: unknown[];
  }[] = [];

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
    q.bounds = [...this.bounds];
    return q;
  }

  doc(id?: string) {
    // Was `auto-${store.size + 1}`, so two unsaved refs got the SAME id and ids
    // were reused after a delete — a later write silently overwrote an earlier
    // document. Monotonic per fake, like a real auto-id.
    const key = id ?? this.owner.nextAutoId();
    /**
     * `validateResourcePath` (`path.js:445-452`) runs BEFORE any splitting, and
     * only when an id was actually given (an omitted argument skips straight to
     * auto-id — `collection-reference.js:184-187`): a bare `""` is "must be a
     * non-empty string", and a `"//"` ANYWHERE is "must not contain //". Neither
     * check exists once `.split("/")` has already run, so a fake that split
     * first accepted both — silently creating a doc keyed `""`, or one whose
     * "parent" path contained an empty segment — instead of throwing.
     */
    if (id !== undefined) {
      if (key === "") {
        throw new Error(`fake-firestore: documentPath must be a non-empty string, got ""`);
      }
      if (key.includes("//")) {
        throw new Error(`fake-firestore: "${key}" must not contain //`);
      }
    }
    /**
     * `.doc()` SPLITS ON "/" and treats the result as a path — an even segment
     * count addresses a COLLECTION and throws a bare `Error`, which the handler
     * renders as 500 "Something went wrong". That is the whole reason
     * `isDocumentId` guards exist (`src/utlils/firestore-id.ts`), and a fake that
     * accepted "a/b" as an ordinary key could not tell whether a repository still
     * had its guard: the malformed id just read back as a missing document.
     *
     * `Path.split()` (`path.js:262-265`) then FILTERS OUT empty segments, so a
     * leading or trailing single "/" is normalised away rather than rejected —
     * "/a" and "a/" both resolve to the one segment "a", same as plain "a".
     */
    const segments = key.split("/").filter((s) => s.length > 0);
    if (segments.length % 2 === 0) {
      throw new Error(
        `fake-firestore: "${key}" points to a collection, not a document`
      );
    }
    const leaf = segments[segments.length - 1];
    if (segments.length > 1) {
      const parent = `${this.name}/${segments.slice(0, -1).join("/")}`;
      return new FakeDocRef(this.owner, parent, leaf, `${parent}/${leaf}`);
    }
    return new FakeDocRef(this.owner, this.name, leaf, `${this.name}/${leaf}`);
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

  /**
   * The four range bounds. `startAt`/`endAt` are what makes a PREFIX SEARCH a
   * prefix search — `content.repository.getIdeas` bounds an active search with
   * `startAt(text)` … `endAt(text + "\uf8ff")`, and a fake that ignored them
   * returned every idea in the channel from a query that in production returns
   * only matches, so a search test could not tell the difference.
   */
  startAfter(...values: unknown[]) {
    return this.bound("startAfter", values);
  }

  startAt(...values: unknown[]) {
    return this.bound("startAt", values);
  }

  endAt(...values: unknown[]) {
    return this.bound("endAt", values);
  }

  private bound(kind: "startAt" | "startAfter" | "endAt", values: unknown[]) {
    const q = this.clone();
    q.bounds.push({ kind, values });
    return q;
  }

  /**
   * Firestore always appends an implicit `__name__` tie-break, in the
   * direction of the LAST explicit `orderBy` — unconditionally for sorting
   * (`query.js`'s `comparator()`, :1059-1064: "Add implicit sorting by name,
   * using the last specified direction") and, when a cursor is positioned by
   * a `DocumentSnapshot`, for the cursor bound too (`createImplicitOrderBy`,
   * :497 "The order of the implicit ordering always matches the last
   * explicit order by", :514-517).
   *
   * Without it, two rows tied on every declared field compare equal and a
   * `startAfter` on one of them either drops or keeps the other by
   * coincidence of iteration order — the doc-id tie-break is what makes that
   * deterministic in production. Skipped when the caller already ordered by
   * `__name__` explicitly (there is nothing implicit left to add), or when
   * there are no declared orders at all (the two call sites below already
   * fall back to a bare `__name__` order of their own).
   */
  private effectiveOrders(): { field: string; dir: string }[] {
    if (this.orders.length === 0) return [];
    if (this.orders.some((o) => o.field === "__name__")) return this.orders;
    return [...this.orders, { field: "__name__", dir: this.orders[this.orders.length - 1].dir }];
  }

  async get() {
    /**
     * Firestore requires an inequality/range filter's field to be the FIRST
     * orderBy — `getInequalityFilterFields()` (query.js:463-476) is how the
     * SDK locates that field so it can implicitly order by it first, and the
     * SERVER rejects a query where an explicit orderBy on a different field
     * comes first instead. Only that one rule is enforced (a single range
     * field vs. the first declared order) — multiple range filters on
     * DIFFERENT fields are a separate, also-illegal shape this fake does not
     * detect; that is query-planning, not "does this fake lie".
     */
    const rangeFields = new Set(this.filters.filter((f) => (RANGE_OPS as readonly string[]).includes(f.op)).map((f) => f.field));
    if (rangeFields.size === 1 && this.orders.length > 0) {
      const [rangeField] = rangeFields;
      if (this.orders[0].field !== rangeField) {
        throw new Error(
          `fake-firestore: inequality filter on "${rangeField}" must be the first orderBy field, got "${this.orders[0].field}"`
        );
      }
    }

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

    for (const o of [...this.effectiveOrders()].reverse()) {
      rows.sort((a, b) => {
        const av = o.field === "__name__" ? a.id : at(a.d, o.field);
        const bv = o.field === "__name__" ? b.id : at(b.d, o.field);
        const cmp = compareOrdered(av, bv);
        return o.dir === "desc" ? -cmp : cmp;
      });
    }

    for (const { kind, values } of this.bounds) {
      /**
       * Firestore positions a bound by the ORDERED FIELD VALUES, and keeps every
       * row on the requested side of them. It does NOT require the bound's
       * document to be in the result set.
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
       * So: build the bound's ordered values — from the snapshot's data, or from
       * the raw values as given — and compare lexicographically against each
       * row's, honouring each order's direction.
       */
      const asSnapshot = values[0] as { id?: string; data?: () => Doc } | undefined;
      const fromSnapshot =
        values.length === 1 && asSnapshot != null && typeof asSnapshot.data === "function";

      // The implicit `__name__` tie-break (see `effectiveOrders`) is only added
      // for a DocumentSnapshot cursor — `createImplicitOrderBy` (query.js:488-489)
      // gates it on exactly that, and leaves a raw-values cursor's declared
      // orders untouched, which is why `startAfter("Same", "a")` must add its
      // own explicit `__name__` orderBy to get a tie-break at all.
      const effective = fromSnapshot ? this.effectiveOrders() : this.orders;
      const orders = effective.length ? effective : [{ field: "__name__", dir: "asc" }];
      const boundValues = fromSnapshot
        ? orders.map((o) =>
            o.field === "__name__" ? asSnapshot!.id : at(asSnapshot!.data!(), o.field)
          )
        : values;

      const compare = (rowValues: unknown[]): number => {
        for (let i = 0; i < boundValues.length; i++) {
          const a = rowValues[i];
          const b = boundValues[i];
          if (a === b) continue;
          const cmp = compareOrdered(a, b);
          if (cmp !== 0) return orders[i]?.dir === "desc" ? -cmp : cmp;
        }
        return 0;
      };

      const keep = (cmp: number) => {
        switch (kind) {
          case "startAfter":
            return cmp > 0;
          case "startAt":
            return cmp >= 0;
          default:
            return cmp <= 0;
        }
      };

      rows = rows.filter(({ id, d }) =>
        keep(compare(orders.map((o) => (o.field === "__name__" ? id : at(d, o.field)))))
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
          // Tagged, and resolved into a Timestamp at write time — see
          // `resolveValue`. As a bare `Date.now()` it was indistinguishable from
          // the client-side `Date.now()` the conventions forbid, and it crashed
          // every repository that reads the field back with `.toDate()`.
          serverTimestamp: () => ({ __fv: "serverTimestamp" }),
          // Tagged, then resolved against what is stored at write time — see
          // `resolveValue`. Returning the raw number made every increment a set.
          increment: (n: number) => ({ __fv: "increment", by: n }),
          delete: () => ({ __fv: "delete" }),
        },
        // Repositories reach for this off `firebase.firestore` as well as the
        // named import; the query treats the sentinel as the document id.
        FieldPath: { documentId: () => ({ __name__: "__name__" }) },
        // `content.repository.getIdeas` converts an ISO cursor into a Timestamp
        // before handing it to `startAfter`, so the bound arrives as one of these
        // and has to be comparable with whatever is stored.
        Timestamp: {
          fromDate: (d: Date) => fakeTimestamp(d.getTime()),
          fromMillis: (n: number) => fakeTimestamp(n),
          now: () => fakeTimestamp(Date.now()),
        },
      },
    },
  };
};
