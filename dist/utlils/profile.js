// Profile completeness (3.4): a read-time, weighted score over the user record.
// Drives the FE completeness meter and "what to add next" nudges. Never
// persisted — computed on every GET /profile from whatever the record holds.
//
// Weighting: the four core-identity fields carry most of the weight (they drive
// generation quality); the enrichment fields round it out. Weights sum to 100.
const isFilledString = (value) => typeof value === "string" && value.trim().length > 0;
const isFilledArray = (value) => Array.isArray(value) && value.length > 0;
const COMPLETENESS_FIELDS = [
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
export function computeProfileCompleteness(record) {
    const source = record ?? {};
    let score = 0;
    const missing = [];
    for (const field of COMPLETENESS_FIELDS) {
        if (field.filled(source)) {
            score += field.weight;
        }
        else {
            missing.push(field.key);
        }
    }
    return { score, missing };
}
