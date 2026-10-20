export class HttpError extends Error {
    constructor(message, statusCode = 500, detail, code) {
        super(message);
        this.name = "HttpError";
        this.statusCode = statusCode;
        this.detail = detail;
        this.code = code;
        Object.setPrototypeOf(this, HttpError.prototype);
    }
}
export const NotFound = (message = "Not found", detail) => new HttpError(message, 404, detail);
export const Forbidden = (message = "Forbidden", detail) => new HttpError(message, 403, detail);
export const BadRequest = (message, detail) => new HttpError(message, 400, detail);
export const Conflict = (message, detail) => new HttpError(message, 409, detail);
export const Unauthorized = (message = "Unauthorized", detail) => new HttpError(message, 401, detail);
// Upstream (Gemini / YouTube) produced nothing usable. Not the caller's fault and
// not an internal defect — the creator should be told plainly and offered a retry.
export const ServiceUnavailable = (message, detail) => new HttpError(message, 503, detail);
// The three 403s, as named factories rather than a `code` argument on Forbidden().
// `message`, `detail` and `code` would otherwise be three loosely-typed trailing
// parameters in a row — the same positional trap that let `batchId` land in an
// `accountId` slot in Phase 03. A named factory cannot be called wrongly.
/** Not a member of this account at all → client clears the account, shows the list. */
export const AccountForbidden = (message = "You do not have access to this channel", detail) => new HttpError(message, 403, detail, "account_forbidden");
/**
 * Member of the resource's account, but currently acting in a different one.
 *
 * Worth the extra code: without it, opening a bookmarked project that lives in
 * your other channel renders "Project not found. It may have been deleted."
 * The project is one switch away, and the server knows both sides — so `detail`
 * carries the owning account so the client can offer that switch.
 */
export const WrongAccount = (detail, message = "This item belongs to another one of your channels") => new HttpError(message, 403, detail, "wrong_account");
/** Member, but the role doesn't allow it → inline message, stay put (Phase 09). */
export const RoleForbidden = (message = "Your role does not allow this action", detail) => new HttpError(message, 403, detail, "role_forbidden");
/** A tombstoned channel. 410, not 404 — it existed, and saying so is repairable. */
export const Gone = (message = "This channel has been deleted", detail) => new HttpError(message, 410, detail);
/** Generation gate only; saves and exports never call this. */
export const InsufficientCredits = (message, detail) => new HttpError(message, 402, detail, "insufficient_credits");
