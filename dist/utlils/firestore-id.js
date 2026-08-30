/**
 * Is this client-supplied string safe to hand to `.doc()`?
 *
 * `db.collection("accounts").doc(value)` splits `value` on "/" and treats the
 * result as a PATH, not as an id. Two consequences, both reached from a plain
 * authenticated request:
 *
 * - `X-Account-Id: <someone-elses-id>/context/channel` is an even number of
 *   segments, so it resolves — and the middleware really did read another
 *   channel's context document: its niche, competitors and the uncapped website
 *   scrape. Nothing was returned, but only because that document has no
 *   `memberUids`, so the membership check refused it. The membership check was
 *   doing input validation's job. It also poisoned the leak detector, which logs
 *   `account.id` — the resolved `doc.id`, i.e. "channel", not the probed id.
 * - An odd number of segments (`a/b`) points at a COLLECTION, so `.doc()` throws
 *   a plain `Error`. That has no `statusCode`, so the handler renders it as a
 *   500 "Something went wrong" — on every protected route, from one header.
 *
 * Rejects what Firestore itself rejects, plus the traversal segments. Deliberately
 * not a UUID check: account ids are UUID v4 today, but this guards the id SHAPE
 * for any collection, and a stricter rule here would reject the legacy
 * document ids in `scripts` and `ideas`.
 */
export const isDocumentId = (value) => typeof value === "string" &&
    value.length > 0 &&
    value.length <= 1500 &&
    !value.includes("/") &&
    value !== "." &&
    value !== ".." &&
    !/^__.*__$/.test(value);
