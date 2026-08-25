import { Timestamp } from "firebase-admin/firestore";

/**
 * Multi-account schema (Phase 02). TYPES ONLY — nothing reads or writes these
 * yet. They exist ahead of the code so the indexes, the backfill and the API
 * are all written against one declared shape rather than three guesses.
 */

export type AccountRole = "owner" | "editor" | "viewer";

export interface AccountMember {
  role: AccountRole;
  addedAt: Timestamp;
}

/**
 * `accounts/{accountId}` — a channel.
 *
 * READ ON EVERY AUTHENTICATED REQUEST (Phase 05 checks membership here), which
 * is why the bulky channel context lives in a subcollection instead. See
 * `IChannelContext`.
 *
 * `accountId` is a UUID v4 and NEVER equals a uid — including for a user's first
 * and only channel. See the README decision (2026-08-25): reusing the uid made
 * deletion un-real and made a `userId`-where-`accountId`-belongs bug isolate
 * correctly and therefore stay invisible.
 */
export interface IAccount {
  id: string;

  /**
   * What the channel switcher renders. Required, because a user can finish
   * onboarding today with no channel URL at all, leaving nothing else to show.
   * Computed once at `ensureDefaultAccount` and editable afterwards:
   *   brandName → userTitle → handle(userName) → niche → "Untitled channel"
   */
  displayName: string;
  /** "@foo", derived from the channel URL. Null until onboarded. */
  handle: string | null;

  /**
   * THE THREE MEMBERSHIP FIELDS ARE DELIBERATE REDUNDANCY, and the rule is that
   * they are always written together, in one operation, by one helper. Never let
   * a caller assemble them — that is how you get a member who can query an
   * account but has no role.
   *
   * Why three and not one: Firestore cannot query inside a map, so answering
   * "which channels can I see?" needs a plain array for `array-contains`. The map
   * carries the roles. `ownerUids` is separate because a query may contain only
   * ONE `array-contains` clause — so it cannot be expressed as a second condition
   * on `memberUids`, and it makes two rules cheap to enforce: an account always
   * keeps at least one owner, and you cannot delete your login while you are the
   * last owner of any account.
   */
  memberUids: string[];
  ownerUids: string[];
  members: Record<string, AccountMember>;

  billingOwnerUid: string;

  /**
   * Tombstone, not a hard delete (Phase 05). It distinguishes "this channel was
   * deleted" (410 Gone) from "this id never existed" (404), which is what stops a
   * stale bookmark or a shared link reading as a bug.
   */
  deletedAt: Timestamp | null;

  createdAt: Timestamp;
  updatedAt: Timestamp;
}

/**
 * `accounts/{accountId}/context/channel` — READ ONLY WHEN GENERATING.
 *
 * Split out of the account document on purpose. `websiteContent` is scraped page
 * text; co-located with the membership fields, a large scrape would make
 * *membership writes* fail against the 1 MiB document limit, and the failure
 * would read as "can't add a member to this channel" with nothing pointing at a
 * website scrape. Subcollections are excluded from the parent's limit.
 *
 * The split is free: Firestore bills per document read, not per byte, and the
 * generation sites read exactly one document either way.
 */
export interface IChannelContext {
  /** Channel URL. Legacy field name from `users/{uid}`, kept deliberately. */
  userName: string;
  channelId: string;
  channelDescription: string;
  userTitle: string;

  niche: string;
  targetAudience: string;
  brandName: string;

  website: string;
  websiteContent: string;

  competitors: { url: string; id?: string; titles?: string[] }[];

  format: "talking_head" | "faceless";
  purpose: string;
  description: string;
}
