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
 * `displayName` is what the switcher renders, so an empty one is a row with
 * nothing to click; the service trims and refuses blanks, and this bounds the
 * length before it gets there.
 *
 * `handle` is editable here because it was otherwise PERMANENT. It is filled by
 * `adoptChannelIdentity` from whatever channel URL onboarding was given — and
 * onboarding is `requireRole("editor")`, while rename is owner-only. So an editor
 * could set a bare channel's handle to anything, once, and no route could ever
 * change it again: adoption only fills a BLANK handle, and this patch used to
 * accept `displayName` alone. Owner-editable closes the asymmetry without
 * blocking an editor from doing the onboarding they are there to do.
 *
 * Everything that decides permissions — `memberUids`, `ownerUids`, `members`,
 * `billingOwnerUid`, `deletedAt` — is absent deliberately and rejected by
 * `.strict()`. Membership is written by one helper (`buildOwnedAccount`) and
 * changed by Phase 09's member management, never by a channel rename.
 */
export const updateAccountSchema = z
  .object({
    displayName: z.string().trim().min(1, "displayName is required").max(120).optional(),
    // Nullable so an owner can clear a wrong handle outright, not just replace it.
    handle: z.string().trim().max(120).nullable().optional(),
  })
  .strict()
  .refine((patch) => patch.displayName !== undefined || patch.handle !== undefined, {
    message: "displayName or handle is required",
  });
