import { Timestamp } from "firebase-admin/firestore";

/**
 * Multi-account schema shared by repositories, request context and the API.
 *
 * The reasoning behind this shape — why the context is a subcollection, why
 * membership is three fields, why ids are UUID v4 — lives in
 * `docs/multi-account/phase-02-accounts-schema-and-indexes.md`. It is NOT
 * repeated here; two copies of an argument drift, and the doc is the one Phase
 * 05/06b are written from. What stays below is only what a caller can get wrong
 * at the point of use.
 */

export type AccountRole = "owner" | "editor" | "viewer";

export interface AccountMember {
  role: AccountRole;
  addedAt: Timestamp;
}

/** `accounts/{accountId}` — a channel. Read on every authenticated request. */
export interface IAccount {
  /** UUID v4. NEVER equals a uid, including for a user's first channel. */
  id: string;

  /**
   * What the switcher renders. Required — a user can finish onboarding with no
   * channel URL at all, so there is not always a handle to fall back on.
   */
  displayName: string;
  /** "@foo", derived from the channel URL. Null until onboarded. */
  handle: string | null;

  /**
   * Deliberate redundancy: always written together, in one operation, by one
   * helper. A caller assembling these by hand is how you get a member who can
   * query an account but has no role.
   */
  memberUids: string[];
  ownerUids: string[];
  members: Record<string, AccountMember>;

  billingOwnerUid: string;

  /** Tombstone, not a hard delete — distinguishes 410 Gone from 404. */
  deletedAt: Timestamp | null;
  /** Direct auth deletion left no owner or billing payer; operator recovery required. */
  orphanedAt?: Timestamp | null;
  orphanedReason?: "billing_owner_deleted" | "last_owner_deleted";

  createdAt: Timestamp;
  updatedAt: Timestamp;
}

/** One row of the switcher (Phase 06a). */
export interface IAccountSummary {
  id: string;
  name: string;
  handle: string | null;
  role: AccountRole;
  /** The switcher routes on this: false sends the user to onboarding. */
  isOnboarded: boolean;
  /**
   * Live videos in this channel. Deliberately on the LIST, not behind a click —
   * it is what makes a channel whose documents went missing visible at a glance.
   */
  projectCount: number;
  completeness: { score: number; missing: string[] } | null;
  /** Phase 08. Null for everyone until then, and null unless I am the billing owner. */
  credits: { remaining: number; resetsAt: string } | null;
}

/**
 * `accounts/{accountId}/context/channel` — read only when generating.
 *
 * Kept out of the account document so an unbounded `websiteContent` scrape can
 * never make a *membership* write fail against the 1 MiB limit.
 */
export interface IChannelContext {
  /** Channel URL. Legacy field name from `users/{uid}`, kept deliberately. */
  userName: string;
  channelId: string;
  channelDescription: string;
  /**
   * The channel's top-performing VIDEO titles, not its name — `formatUserData`
   * writes `channel.titles` here. Declared `string` until now, which is what let
   * the two writers below store `""` and crash `formatCreatorsData`.
   */
  userTitle: string[];

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
