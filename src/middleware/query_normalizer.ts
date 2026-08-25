import { NextFunction, Request, Response } from "express";

/**
 * Collapse repeated query params to a single string.
 *
 * Express parses `?query=a&query=b` into `["a", "b"]` and `?query[x]=1` into an
 * object. Every controller that reads `req.query` casts the value with
 * `as string` — research, ideas and video-projects all do — so a non-string
 * value flows straight past the type system into code that calls `.trim()` or
 * concatenates it into a URL. `GET /v1/research/keywords?query=a&query=b`
 * returned a 500 ("Something went wrong") from `query.trim is not a function`;
 * a malformed request deserves a 400 at worst, never a server error.
 *
 * Fixed here rather than in the three controllers because the `as string` lie is
 * the same lie in each, and a fourth controller would inherit it. No route in
 * this API takes a list-valued query param, so the last occurrence wins —
 * matching how browsers and most servers treat a duplicated key.
 *
 * ponytail: last-wins is a policy, not a validation. If a route ever needs a
 * real array or a typed query, give that route a zod schema instead of widening
 * this.
 */
export const queryNormalizer = (req: Request, _res: Response, next: NextFunction): void => {
  const query = req.query as Record<string, unknown>;

  for (const key of Object.keys(query)) {
    const value = query[key];
    if (Array.isArray(value)) {
      const last = value[value.length - 1];
      query[key] = typeof last === "string" ? last : "";
    } else if (value !== undefined && typeof value !== "string") {
      // `?query[x]=1` parses to an object. There is no sensible string for it,
      // and coercing would produce "[object Object]".
      query[key] = "";
    }
  }

  next();
};

export default queryNormalizer;
