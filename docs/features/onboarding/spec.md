---
title: "Onboarding — Feature Spec"
description: "User flow, data enrichment, and edge cases for the Onboarding step"
date: 2026-02-27
last_updated: 2026-03-17
status: "implemented"
tags: ["feature", "onboarding", "spec"]
---

# Onboarding — Feature Spec

## Overview

Onboarding is the **pre-pipeline step** that runs once before any video project work. The creator provides their channel context — brand, niche, audience, competitors, website — and MomentumX enriches it with live data from YouTube and the web.

This context persists on the user's document and is injected into every AI generation throughout the app. Without onboarding data, generated content will be generic and uncontextualised.

---

## Pipeline Position

```
[Onboarding] → Research → Script → Hooks → Packaging
```

| Attribute | Value |
|---|---|
| Runs | Once, before any pipeline work. Can be re-submitted to update. |
| Blocks | No hard enforcement — but generation quality degrades without onboarding data |
| Output | Enriched user document in `users` Firestore collection |

---

## What the Creator Provides

| Field | Type | Description |
|---|---|---|
| `userName` | `string` | Their YouTube channel URL |
| `brandName` | `string` | Their brand or channel name |
| `niche` | `string` | Content niche (e.g. "AI productivity tools") |
| `purpose` | `string` | Channel purpose / mission |
| `targetAudience` | `string` | Who the content is for |
| `competitors` | `string[]` | Competitor YouTube channel URLs |
| `website` | `string` | Optional — brand/personal website URL |
| `description` | `string` | Channel description |

---

## What Happens on Submission

`PATCH /v1/user/onboarding` triggers a multi-step enrichment process via `formatUserData()` in `src/utlils/content.ts`. Each external call is isolated in its own try/catch — onboarding succeeds even if individual enrichment steps fail.

### Step-by-step

1. **Website scraping** (if `website` provided)
   - `UserRepository.getWebsiteContent(website)` fetches the URL via `fetch()` and strips HTML to plain text using `extractTextFromHTML()`
   - Result stored as `websiteContent` on the user document
   - If scraping fails, `websiteContent` is `""` — onboarding still saves

2. **Channel ID lookup** (for creator's own channel)
   - `ExtractService.retrieveChannelId(userName)` calls YouTube Data API v3
   - Returns `{ id: channelId, description: channelDescription }`
   - If lookup fails, `channelId` is `""` and top titles cannot be fetched

3. **Competitor channel ID lookups** (one per competitor URL)
   - Same `retrieveChannelId()` called for each competitor URL
   - Failures per competitor are independent — one failure doesn't block others

4. **Top 10 titles fetch** (creator's channel + each competitor)
   - `ExtractService.getTopTenTitle(channelId)` calls YouTube Data API v3
   - Returns array of top 10 video titles by view count
   - Stored on user document as `userTitle` (creator's own) and `competitors[].titles` (per competitor)
   - If a channel ID lookup failed upstream, this step is skipped for that channel

5. **Save to Firestore**
   - All enriched data merged onto `users/{userId}` via `repo.add()` with `{ merge: true }`
   - The save happens in a `finally` block — it runs even if enrichment partially failed

### Response includes a warning

If `websiteContent` is empty after scraping (failed or not provided), the response includes:
```json
"warning": "Website content is not parsed"
```

This is surfaced to the frontend so the creator knows the website context is missing.

---

## User Document Shape

Stored in the `users` Firestore collection. Document ID = Firebase UID (`req.userId`).

| Field | Type | Source |
|---|---|---|
| `userName` | `string` | Creator-provided (YouTube channel URL) |
| `brandName` | `string` | Creator-provided |
| `niche` | `string` | Creator-provided |
| `purpose` | `string` | Creator-provided |
| `targetAudience` | `string` | Creator-provided |
| `description` | `string` | Creator-provided |
| `website` | `string` | Creator-provided (optional) |
| `competitors` | `{ url, id, titles[] }[]` | Enriched — IDs and titles from YouTube API |
| `channelId` | `string` | Enriched — from YouTube Data API |
| `userTitle` | `string[]` | Enriched — creator's top 10 video titles |
| `websiteContent` | `string` | Enriched — scraped + stripped plain text |
| `stats.topics` | `number` | Incremented each time topics are generated |
| `stats.scripts` | `number` | Incremented each time a script is generated |

---

## Idempotency

`PATCH /v1/user/onboarding` uses `{ merge: true }` — re-submitting overwrites the previous data. There is no "first time" vs "update" distinction in the backend. Both the onboarding endpoint and the profile update endpoint call `formatUserData()` and re-run the full enrichment.

---

## Known Gaps

| Gap | Impact |
|---|---|
| Competitor data never refreshes | Fetched once at onboarding. If a competitor publishes a viral video after onboarding, MomentumX won't surface it. Undermines competitive intelligence over time. |
| Creator's own titles never refresh | `userTitle` is a snapshot from onboarding. New uploads by the creator aren't reflected until they re-submit onboarding. |
| `getWebsiteContent` in wrong layer | Website scraping (outbound HTTP) lives in `UserRepository`. This violates the architecture rule that repositories only touch Firestore. Should move to `ExtractService`. |
| `PATCH /onboarding` returns full enriched payload | The full user document including `websiteContent` (potentially large) and `userTitle` is returned in the response. Should be trimmed. |
| No input validation | No check that required fields (`brandName`, `niche`, etc.) are present. Missing fields produce degraded AI output, not a 400. |

---

## Build Status

| Capability | Status |
|---|---|
| Onboarding form data submission | ✅ Built |
| YouTube channel ID lookup | ✅ Built |
| Creator's top 10 titles from YouTube | ✅ Built |
| Competitor channel ID + title lookup | ✅ Built |
| Website scraping + HTML stripping | ✅ Built |
| Partial failure isolation (each step isolated) | ✅ Built |
| Get profile | ✅ Built |
| Update profile | ✅ Built |
| Data refresh (re-fetch YouTube / website data) | ❌ Only on re-submit — no scheduled refresh |
| Input validation | ❌ Not built |

---

## Related Documentation

- [Onboarding API Reference](./api.md)
- [Product Overview](../../product/overview.md)
- [Product Roadmap](../../product/roadmap.md)
