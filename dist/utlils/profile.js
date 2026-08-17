// Profile completeness (3.4): a read-time, weighted score over the user record.
// Drives the FE completeness meter and "what to add next" nudges. Never
// persisted — computed on every GET /profile from whatever the record holds.
//
// Weighting: the four core-identity fields carry most of the weight (they drive
// generation quality); the enrichment fields round it out. Weights sum to 100.
// One predicate covers both stored shapes here: strings and arrays. Every field
// used to carry its own `filled` closure that did exactly this on `r[key]`.
const isFilled = (value) => Array.isArray(value)
    ? value.length > 0
    : typeof value === "string" && value.trim().length > 0;
// [field, weight] — core identity carries 60, enrichment the remaining 40.
const COMPLETENESS_FIELDS = [
    ["niche", 15],
    ["targetAudience", 15],
    ["brandName", 15],
    ["userName", 15],
    ["website", 10],
    ["competitors", 10],
    ["userTitle", 10],
    ["channelDescription", 10],
];
export function computeProfileCompleteness(record) {
    const source = record ?? {};
    let score = 0;
    const missing = [];
    for (const [key, weight] of COMPLETENESS_FIELDS) {
        if (isFilled(source[key]))
            score += weight;
        else
            missing.push(key);
    }
    return { score, missing };
}
