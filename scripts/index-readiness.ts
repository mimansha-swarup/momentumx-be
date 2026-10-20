export interface IndexDefinition {
  collectionGroup: string;
  queryScope: string;
  fields: { fieldPath: string; order?: string; arrayConfig?: string }[];
}

export interface LiveIndex {
  name?: string;
  state?: string;
  queryScope?: string;
  fields?: IndexDefinition["fields"];
}

// Firestore adds a document-name tie breaker when it is omitted in Firebase config.
const fieldsKey = (fields: IndexDefinition["fields"]): string => {
  const normalized = fields.map(({ fieldPath, order, arrayConfig }) => ({ fieldPath, order, arrayConfig }));
  if (!normalized.some((field) => field.fieldPath === "__name__")) {
    const order = normalized.filter((field) => field.order).at(-1)?.order ?? "ASCENDING";
    normalized.push({ fieldPath: "__name__", order, arrayConfig: undefined });
  }
  return JSON.stringify(normalized);
};

export function indexReadiness(declared: IndexDefinition[], live: LiveIndex[]) {
  return declared.map((definition) => {
    const matches = live.filter((index) =>
      index.name?.split("/collectionGroups/")[1]?.split("/")[0] === definition.collectionGroup &&
      index.queryScope === definition.queryScope &&
      index.fields && fieldsKey(index.fields) === fieldsKey(definition.fields));
    return {
      ...definition,
      state: matches.find((index) => index.state === "READY")?.state ?? matches[0]?.state ?? "MISSING",
    };
  }).filter((index) => index.state !== "READY");
}
