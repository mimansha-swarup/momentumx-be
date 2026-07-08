import { DocumentData } from "firebase-admin/firestore";

// Profile completeness (3.4): a read-time, weighted score over the user record.
// Drives the FE completeness meter and "what to add next" nudges. Never
// persisted — computed on every GET /profile from whatever the record holds.
//
// Weighting: the four core-identity fields carry most of the weight (they drive
// generation quality); the enrichment fields round it out. Weights sum to 100.

const isFilledString = (value: unknown): boolean =>
  typeof value === "string" && value.trim().length > 0;

const isFilledArray = (value: unknown): boolean =>
  Array.isArray(value) && value.length > 0;

interface ICompletenessField {
  key: string;
  weight: number;
  filled: (record: DocumentData) => boolean;
}

const COMPLETENESS_FIELDS: ICompletenessField[] = [
  // Core identity — 60 total.
  { key: "niche", weight: 15, filled: (r) => isFilledString(r.niche) },
  { key: "targetAudience", weight: 15, filled: (r) => isFilledString(r.targetAudience) },
  { key: "brandName", weight: 15, filled: (r) => isFilledString(r.brandName) },
  { key: "userName", weight: 15, filled: (r) => isFilledString(r.userName) },
  // Enrichment — 40 total.
  { key: "website", weight: 10, filled: (r) => isFilledString(r.website) },
  { key: "competitors", weight: 10, filled: (r) => isFilledArray(r.competitors) },
  { key: "userTitle", weight: 10, filled: (r) => isFilledArray(r.userTitle) },
  { key: "channelDescription", weight: 10, filled: (r) => isFilledString(r.channelDescription) },
];

export interface IProfileCompleteness {
  score: number; // 0–100
  missing: string[]; // fields not yet filled, in priority order
}

export function computeProfileCompleteness(
  record: DocumentData | undefined | null
): IProfileCompleteness {
  const source = record ?? {};
  let score = 0;
  const missing: string[] = [];

  for (const field of COMPLETENESS_FIELDS) {
    if (field.filled(source)) {
      score += field.weight;
    } else {
      missing.push(field.key);
    }
  }

  return { score, missing };
}
