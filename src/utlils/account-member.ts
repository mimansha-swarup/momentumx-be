import type { AccountRole } from "../types/routes/account.js";

/** Firebase UIDs can be object-prototype names; only stored, valid roles grant access. */
export function memberRole(members: unknown, uid: string): AccountRole | undefined {
  if (!members || typeof members !== "object" || !Object.prototype.hasOwnProperty.call(members, uid)) return undefined;
  const role = (members as Record<string, { role?: unknown } | undefined>)[uid]?.role;
  return role === "owner" || role === "editor" || role === "viewer" ? role : undefined;
}
