/**
 * Turn a client-supplied `?limit=` into a number the database can be trusted with.
 *
 * Both list endpoints took the raw value straight through:
 *   /v1/ideas          → parseInt(limit) → query.limit(n)
 *   /v1/video-projects → parseInt(limit) → query.limit(n + 1)
 *
 * So `?limit=1000000` was a million-document read inside a Vercel function's
 * time budget, and `?limit=abc` reached Firestore as `limit(NaN)`. Neither is a
 * thing a client should be able to ask for, and `docs/features/video-project/api.md`
 * already documented a maximum of 50 that nothing enforced.
 *
 * Clamped rather than rejected: a nonsense limit is a client bug, and failing the
 * whole listing over it would break the page for a user who did nothing wrong.
 * The page just comes back at the cap.
 */
export const parseListLimit = (
  raw: unknown,
  { fallback, max }: { fallback: number; max: number }
): number => {
  const parsed = typeof raw === "string" ? Number.parseInt(raw, 10) : Number.NaN;
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, max);
};

/** Ideas list — 9 per page in the UI grid. */
export const IDEAS_PAGE = { fallback: 9, max: 50 };

/** Video projects list — documented default 20, maximum 50. */
export const PROJECTS_PAGE = { fallback: 20, max: 50 };
