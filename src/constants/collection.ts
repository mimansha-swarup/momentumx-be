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
  // places first. Nothing reads or writes these yet.
  ACCOUNTS = "accounts",
  BILLING = "billing",
  INVITES = "invites",
  MIGRATIONS = "migrations",
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
}

/** The single document id inside `accounts/{accountId}/context`. */
export const CHANNEL_CONTEXT_DOC = "channel";

export const stats = {
  ideas: 0,
  scripts: 0,
  credits: 0,
};
