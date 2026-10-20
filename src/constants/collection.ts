export const enum COLLECTIONS {
  USERS = "users",
  SCRIPTS = "scripts",
  IDEAS = "ideas",
  PACKAGING = "packaging",
  VIDEO_PROJECTS = "videoProjects",
  HOOKS = "hooks",
  EVENTS = "events",

  // Multi-account (Phase 02). Declared with the schema rather than when the
  // first repository needs them — firestore-conventions.md requires every
  // collection name to live here, and a name added later gets hardcoded in four
  // places first. Repositories now use these for tenancy, billing and sharing.
  ACCOUNTS = "accounts",
  BILLING = "billing",
  INVITES = "invites",
  YOUTUBE_CACHE = "youtubeCache",
}

/**
 * Sub-collection path segments. Separate from COLLECTIONS because these are
 * never a top-level collection — they are always the child half of
 * `accounts/{id}/context/channel` or `accounts/{id}/usage/{YYYY-MM}`.
 */
export const enum SUBCOLLECTIONS {
  /** accounts/{accountId}/context/channel — the generation-time channel context. */
  CONTEXT = "context",
  /** accounts/{accountId}/usage/{YYYY-MM} — month-keyed counters (Phase 08). */
  USAGE = "usage",
  /** One timestamp per changed member; prevents stale invitations restoring access. */
  MEMBERSHIP_CHANGES = "membershipChanges",
}

/** The single document id inside `accounts/{accountId}/context`. */
export const CHANNEL_CONTEXT_DOC = "channel";

export const stats = {
  ideas: 0,
  scripts: 0,
  credits: 0,
};
