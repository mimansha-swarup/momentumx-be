import { indexReadiness, IndexDefinition, LiveIndex } from "../../../scripts/index-readiness";
const definition: IndexDefinition = { collectionGroup: "invites", queryScope: "COLLECTION", fields: [
  { fieldPath: "email", order: "ASCENDING" }, { fieldPath: "status", order: "ASCENDING" }, { fieldPath: "expiresAt", order: "ASCENDING" },
] };
const live: LiveIndex = { name: "projects/demo/databases/(default)/collectionGroups/invites/indexes/id", queryScope: "COLLECTION", fields: [...definition.fields, { fieldPath: "__name__", order: "ASCENDING" }], state: "READY" };
it("reports missing declared indexes", () => {
  expect(indexReadiness([definition], [])).toEqual([{ ...definition, state: "MISSING" }]);
});
it.each(["CREATING", "NEEDS_REPAIR"])("does not accept %s as ready", state => {
  expect(indexReadiness([definition], [{ ...live, state }])[0].state).toBe(state);
});
it("accepts Firestore's implicit document name ordering", () => {
  expect(indexReadiness([definition], [live])).toEqual([]);
});
it("accepts implicit descending document name ordering", () => {
  const descending = { ...definition, fields: [...definition.fields.slice(0, -1), { fieldPath: "expiresAt", order: "DESCENDING" }] };
  expect(indexReadiness([descending], [{ ...live, fields: [...descending.fields, { fieldPath: "__name__", order: "DESCENDING" }] }])).toEqual([]);
});
it("honors explicit document name ordering", () => {
  const explicit = { ...definition, fields: [...definition.fields, { fieldPath: "__name__", order: "DESCENDING" }] };
  expect(indexReadiness([explicit], [{ ...live, fields: explicit.fields }])).toEqual([]);
  expect(indexReadiness([explicit], [live])[0].state).toBe("MISSING");
});
it.each([
  { queryScope: "COLLECTION_GROUP" },
  { name: "projects/demo/databases/(default)/collectionGroups/other/indexes/id" },
  { fields: [...definition.fields.slice(0, -1), { fieldPath: "expiresAt", order: "DESCENDING" }] },
  { fields: [...definition.fields, { fieldPath: "extra", order: "ASCENDING" }] },
  { fields: [{ fieldPath: "email", arrayConfig: "CONTAINS" }, ...definition.fields.slice(1)] },
])("rejects an index for a different query shape: %j", patch => {
  expect(indexReadiness([definition], [{ ...live, ...patch }])[0].state).toBe("MISSING");
});
it("accepts a READY duplicate while another matching index is building", () => {
  expect(indexReadiness([definition], [{ ...live, state: "CREATING" }, live])).toEqual([]);
});
