import { readFile } from "node:fs/promises";
import { indexReadiness, type IndexDefinition, type LiveIndex } from "./index-readiness.js";

const args = process.argv.slice(2);
if (args.some((arg) => arg !== "--check")) throw Error("Usage: inventory-indexes.ts [--check]");

// Read-only production inventory; no create/update/delete endpoint exists here.
const encoded = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
if (!encoded) throw Error("FIREBASE_SERVICE_ACCOUNT_BASE64 is required");
const project = JSON.parse(Buffer.from(encoded, "base64").toString("utf8")).project_id;
if (typeof project !== "string" || !/^[a-z][a-z0-9-]+$/.test(project)) throw Error("Invalid project id");
const { firebase } = await import("../src/config/firebase.js");
const token = await firebase.app().options.credential!.getAccessToken();
const indexes: LiveIndex[] = [];
let pageToken: string | undefined;
do {
  const url = new URL(`https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/collectionGroups/-/indexes`);
  if (pageToken) url.searchParams.set("pageToken", pageToken);
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token.access_token}` } });
  if (!response.ok) throw Error(`Read-only index inventory failed: HTTP ${response.status}`);
  const page = (await response.json()) as { indexes?: LiveIndex[]; nextPageToken?: string };
  indexes.push(...(page.indexes ?? []).map((index) => ({ name: index.name, state: index.state, queryScope: index.queryScope, fields: index.fields })));
  pageToken = page.nextPageToken;
} while (pageToken);
const declared = JSON.parse(await readFile(new URL("../firestore.indexes.json", import.meta.url), "utf8")) as { indexes: IndexDefinition[] };
const pending = indexReadiness(declared.indexes, indexes);
console.log(JSON.stringify({ project, collectedAt: new Date().toISOString(),
  ...(args.includes("--check") ? { ready: pending.length === 0, pending } : { live: indexes, declared: declared.indexes }),
}, null, 2));
if (args.includes("--check") && pending.length > 0) process.exitCode = 1;
