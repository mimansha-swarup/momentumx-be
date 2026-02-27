---
name: youtube-integration
description: Reference for YouTube Data API v3 usage in MomentumX — channel lookups, top video titles, competitor analysis. Use when building or modifying anything that interacts with the YouTube API.
---

# YouTube Integration Reference

## API Client Setup

```typescript
// src/config/youtube.ts (or wherever initialized)
import { google } from 'googleapis';

const youtube = google.youtube({
  version: 'v3',
  auth: process.env.YT_API,
});
```

## Channel ID Lookup

Given a channel URL, resolve it to a channel ID:

```typescript
async getChannelId(channelUrl: string): Promise<string | null> {
  // Handle different URL formats:
  // https://www.youtube.com/@handle
  // https://www.youtube.com/channel/UCxxxxxxxx

  const handleMatch = channelUrl.match(/@([^/]+)/);
  if (handleMatch) {
    const handle = handleMatch[1];
    const res = await youtube.channels.list({
      part: ['id'],
      forHandle: handle,
    });
    return res.data.items?.[0]?.id ?? null;
  }

  const channelMatch = channelUrl.match(/channel\/([^/]+)/);
  if (channelMatch) {
    return channelMatch[1];
  }

  return null;
}
```

## Top Video Titles by Channel

```typescript
async getTopVideoTitles(channelId: string, maxResults = 10): Promise<string[]> {
  // Step 1: Search for top videos by view count
  const searchRes = await youtube.search.list({
    part: ['id', 'snippet'],
    channelId,
    order: 'viewCount',
    type: ['video'],
    maxResults,
  });

  const titles = searchRes.data.items
    ?.map(item => item.snippet?.title)
    .filter((t): t is string => Boolean(t));

  return titles ?? [];
}
```

## Competitor Analysis (Onboarding)

During onboarding, MomentumX fetches top titles from:
1. The creator's own channel
2. Each competitor's channel

```typescript
async scrapeChannelData(channelUrls: string[]): Promise<Record<string, string[]>> {
  const result: Record<string, string[]> = {};

  for (const url of channelUrls) {
    const channelId = await this.getChannelId(url);
    if (!channelId) continue;

    const titles = await this.getTopVideoTitles(channelId);
    result[url] = titles;
  }

  return result;
}
```

## Key Files

- `src/service/extract.service.ts` — YouTube extraction logic
- `src/repository/extract.repository.ts` — stores extracted channel data
- `src/utlils/content.ts` — `formatUserData()` combines channel data into AI prompt context

## `formatUserData` Usage

```typescript
import { formatUserData } from '../utlils/content';

// Formats user profile + channel data + competitor data into a structured prompt string
const userContext = formatUserData(user);
// Used as part of TOPIC_USER_PROMPT injection
```

## Rate Limits and Quotas

YouTube Data API v3 has a daily quota of 10,000 units. Costs:
- `search.list`: 100 units per call
- `channels.list`: 1 unit per call
- `videos.list`: 1 unit per call

**Implication:** `search.list` is expensive — limit `maxResults` and avoid calling in loops. Competitor data is fetched once at onboarding and stored in Firestore — not re-fetched on every generation.

## Env Var

```
YT_API=<YouTube Data API v3 key>
```

Never hardcode this. Access via `process.env.YT_API`.

## Error Handling

YouTube API calls can fail due to invalid channel URLs, deleted channels, or quota exhaustion. Always handle gracefully:

```typescript
try {
  const titles = await this.getTopVideoTitles(channelId);
  return titles;
} catch (error) {
  // Log and return empty — onboarding should not fail because of one channel
  console.error('YouTube API error for channel', channelId, error);
  return [];
}
```

For quota errors specifically, throw to surface to the user rather than silently returning empty.
