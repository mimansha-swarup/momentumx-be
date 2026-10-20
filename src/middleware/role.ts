import { RequestHandler } from "express";
import { AccountRole } from "../types/routes/account.js";
import { RoleForbidden } from "../utlils/errors.js";

export const requireRole = (minimum: AccountRole): RequestHandler => (req, _res, next) => {
  const levels = { viewer: 0, editor: 1, owner: 2 };
  // An own-property check, never `in`: `in` walks the prototype chain, so a stored role
  // of "constructor", "toString", "hasOwnProperty" or "__proto__" resolved to a
  // function or an object, `<` against it produced NaN, and the comparison was
  // false — so the gate called next(). Verified: all four passed
  // requireRole("owner"). Not reachable through the API today (every writer is
  // zod-restricted to owner|editor|viewer), but this is the one gate that must
  // fail closed, and a direct Firestore write, an import or a migration is enough.
  //
  // `hasOwnProperty.call` rather than `Object.hasOwn` because this project targets
  // a pre-ES2022 lib; it is the idiom already used in `sharing.repository.ts`.
  if (!Object.prototype.hasOwnProperty.call(levels, req.role) || levels[req.role] < levels[minimum]) return next(RoleForbidden());
  next();
};
