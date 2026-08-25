// The filter set for GET /v1/ideas. Typed deliberately rather than left as
// `Record<string, unknown>`: the loose type is what allowed
// `isScriptGenerated: Boolean("false")` to compile and silently invert the
// filter. `undefined` (absent) and `false` mean different things here and the
// compiler now enforces that they are different values.
export interface IIdeaFilters {
  searchText?: string;
  /** Absent → no filter. `false` → only ideas WITHOUT a script. */
  isScriptGenerated?: boolean;
}

/**
 * A page cursor. Its shape follows the ORDERING, not the caller's preference:
 *
 * - default listing orders by `createdAt desc` → `{ createdAt, docId }`
 * - prefix search orders by `title`            → `{ title, docId }`
 *
 * Both carry `docId` as the tiebreaker. Clients treat this as opaque — they echo
 * back whatever `nextCursor` they were handed — so the distinction never leaks
 * into the frontend.
 */
export interface IIdeaCursor {
  createdAt?: string;
  title?: string;
  docId?: string;
}

export interface IGetIdeaByUserIdArgs {
  userId: string;
  limit: number;
  cursor: IIdeaCursor;
  filters: IIdeaFilters;
}
