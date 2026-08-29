import { z } from "zod";

/**
 * `POST /v1/accounts` — an EMPTY body, and the schema says so.
 *
 * Not an oversight: onboarding already owns URL entry, prefill and confirmation,
 * and it needs a real account id to send `X-Account-Id` against. Create-then-
 * onboard reuses those endpoints unchanged.
 *
 * `.strict()` is the load-bearing part. Without it a client could send
 * `{ memberUids: [...] }` or `{ ownerUids: [...] }` and — the moment anyone adds
 * a spread in the service — grant themselves membership of a channel at creation.
 * Refusing unknown keys here means that mistake cannot be made downstream.
 */
export const createAccountSchema = z.object({}).strict();

/**
 * `PATCH /v1/accounts/:id` — channel edits.
 *
 * `displayName` only, for now. It is what the switcher renders, so an empty one
 * is a row with nothing to click; the service trims and refuses blanks, and this
 * bounds the length before it gets there.
 *
 * Everything that decides permissions — `memberUids`, `ownerUids`, `members`,
 * `billingOwnerUid`, `deletedAt` — is absent deliberately and rejected by
 * `.strict()`. Membership is written by one helper (`buildOwnedAccount`) and
 * changed by Phase 09's member management, never by a channel rename.
 */
export const updateAccountSchema = z
  .object({
    displayName: z.string().trim().min(1, "displayName is required").max(120),
  })
  .strict();
