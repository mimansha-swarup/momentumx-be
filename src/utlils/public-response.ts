// Public response contracts are explicit: storage-only fields must stay server-side.
function pick<T extends object, K extends keyof T>(value: T, keys: readonly K[]): Pick<T, K> {
  return Object.fromEntries(keys.filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]])) as Pick<T, K>;
}

export const IDEA_PUBLIC_FIELDS = ["id", "title", "accountId", "concept", "ideaType", "evidence", "createdBy", "createdAt", "updatedAt", "isScriptGenerated", "archived", "videoProjectId", "userFeedback"] as const;
export const publicIdea = (value: object) => {
  const result = pick(value as Record<string, unknown>, IDEA_PUBLIC_FIELDS);
  for (const key of ["createdAt", "updatedAt"] as const) {
    const stamp = result[key];
    if (typeof stamp === "string") continue;
    const date = stamp instanceof Date
      ? stamp
      : typeof (stamp as { toDate?: unknown })?.toDate === "function"
        ? (stamp as { toDate(): Date }).toDate()
        : undefined;
    // A pending serverTimestamp transform is not a timestamp. It stays private;
    // the next persisted list read provides the authoritative date.
    if (date && Number.isFinite(date.getTime())) result[key] = date.toISOString();
    else delete result[key];
  }
  return result;
};

export const publicProfile = (value: object | null | undefined) => {
  const result = pick((value ?? {}) as Record<string, unknown>, ["uid", "email", "name", "photoURL", "createdAt", "isOnboardingCompleted", "userName", "brandName", "niche", "targetAudience", "website", "format", "purpose", "description", "stats", "completeness", "competitors"]);
  if (Array.isArray(result.competitors)) {
    result.competitors = result.competitors.map(value => typeof value === "string" ? { url: value } : pick(value ?? {}, ["url", "id"]));
  }
  return result;
};

export const publicAccount = (value: object) => pick(value as Record<string, unknown>, ["id", "displayName", "handle", "deletedAt", "orphanedAt", "orphanedReason", "createdAt", "updatedAt"]);

export const publicProject = (value: object) => {
  const result = pick(value as Record<string, unknown>, ["id", "accountId", "createdBy", "title", "ideaId", "scriptId", "hooksId", "selectedHookIndex", "packagingId", "thumbnailHint", "pipeline", "overallStatus", "currentStep", "recommendedNextStep", "isDeleted", "deletedAt", "createdAt", "updatedAt"]);
  if (result.pipeline && typeof result.pipeline === "object") {
    result.pipeline = Object.fromEntries(
      Object.entries(result.pipeline)
        .filter(([step]) => ["research", "script", "hooks", "title", "packaging"].includes(step))
        .map(([step, state]) => [step, pick(state ?? {}, ["status", "startedAt", "completedAt", "staleReason"])]),
    );
  }
  return result;
};
