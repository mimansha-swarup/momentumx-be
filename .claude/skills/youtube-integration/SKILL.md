---
name: youtube-integration
description: Reference for YouTube Data API v3 usage in MomentumX — raw REST calls via fetch, channel lookups, top titles, research endpoints, quota costs. Use when building or modifying anything that talks to the YouTube API.
---

# YouTube Integration Reference

## How This Repo Calls YouTube — Raw REST via `fetch`

There is **no API client**. All YouTube access is raw `fetch` against `https://www.googleapis.com/youtube/v3/...` with the key as a query param. (The `googleapis` npm package sits unused in package.json — do not import it; follow the existing fetch pattern.)

```typescript
const API_KEY = process.env.YT_API;

const res = await fetch(
  `https://www.googleapis.com/youtube/v3/search?key=${API_KEY}` +
    `&channelId=${channelId}&part=snippet,id&order=viewCount&type=video&maxResults=${MAX_RESULTS}`
);
const data = await res.json();
const titles = data?.items?.map((v) => v?.snippet?.title);
```

## Where the Code Lives

- `src/repository/extract.repository.ts` — onboarding-time channel scraping:
  - `retrieveChannelId(param)` — resolves a channel URL/@handle to a channel ID (`channels?part=id,brandingSettings`)
  - `getYTChanelTitles(channelId)` — top titles by view count (`search?order=viewCount`)
- `src/service/extract.service.ts` — orchestrates extraction (also fetches website content via `fetch`)
- `src/repository/research.repository.ts` — the `/v1/research` endpoints:
  - trending videos in the user's niche (30-day window, computed with `new Date()` — allowed for query boundaries)
  - competitor channels' top videos
  - keyword signals
  - fetches per-video `statistics.viewCount` via `videos?part=statistics` and weights titles by views
- `src/utlils/content.ts` — `formatUserData()` folds channel + competitor data into AI prompt context

## Onboarding Flow

Competitor and own-channel data is fetched **once at onboarding** and stored in Firestore (`users` doc: `competitors`, `topTitles`) — it is NOT re-fetched on every generation. Research endpoints (`/v1/research/*`) hit the API live per request.

## Quota Budget

Daily quota: 10,000 units. Costs per call:

```
search.list    → 100 units   (expensive — the whole budget is ~100 searches/day)
videos.list    → 1 unit
channels.list  → 1 unit
```

Implications:
- Never call `search` in a loop when one call with a higher `maxResults` works
- Prefer `videos.list` / `channels.list` for enrichment — they're ~free
- Anything new that adds `search` calls per-request (not per-onboarding) needs a hard look at quota math

## Error Handling

Per-channel graceful degradation is deliberate during onboarding — one dead competitor channel must not fail the whole onboarding:

```typescript
try {
  const titles = await this.getYTChanelTitles(channelId);
  return titles;
} catch (error) {
  console.error("YouTube API error for channel", channelId, error);
  return []; // skip this channel, keep onboarding alive
}
```

This is the sanctioned exception to the no-swallow rule — scoped to per-channel fetches only. Quota-exhaustion errors should still throw/surface: silently returning empty data for ALL channels would look like a successful onboarding with no data.

Also check `res.ok` before `res.json()` — the REST API returns error payloads with 4xx statuses, and parsing them as results produces confusing `undefined` chains downstream.

## Env Var

```
YT_API=<YouTube Data API v3 key>
```

Access via `process.env.YT_API` — never hardcode, never log it (it's embedded in fetch URLs, so don't log full request URLs either).
