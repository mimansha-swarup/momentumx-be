---
title: "Onboarding — API Reference"
description: "Endpoint reference for onboarding, profile retrieval, and profile update"
date: 2026-02-27
last_updated: 2026-02-27
status: "draft"
tags: ["api", "onboarding", "user"]
---

# Onboarding API Reference

Base path: `/v1/user`

All endpoints require `Authorization: Bearer <token>`. The user document ID in Firestore is the Firebase UID (`req.userId` from `authMiddleware`).

---

## Endpoints Summary

| Method | URL | Purpose | Status |
|---|---|---|---|
| `PATCH` | `/v1/user/onboarding` | Submit onboarding data | ✅ Built |
| `GET` | `/v1/user/profile` | Get user profile | ✅ Built |
| `PATCH` | `/v1/user/profile` | Update profile fields | ✅ Built |

---

## PATCH `/v1/user/onboarding`

Submit onboarding data. Triggers enrichment: YouTube channel lookup, competitor title fetch, and optional website scrape. Saves all enriched data to `users/{userId}`.

Idempotent — re-submitting overwrites previous onboarding data and re-runs all enrichment.

### Auth
`Authorization: Bearer <token>` — required.

### Request Body

| Field | Type | Required | Description |
|---|---|---|---|
| `userName` | `string` | Yes | Creator's YouTube channel URL |
| `brandName` | `string` | Yes | Brand or channel name |
| `niche` | `string` | Yes | Content niche |
| `purpose` | `string` | Yes | Channel purpose / mission |
| `targetAudience` | `string` | Yes | Target audience description |
| `competitors` | `string[]` | Yes | Array of competitor YouTube channel URLs |
| `description` | `string` | Yes | Channel description |
| `website` | `string` | No | Brand/personal website URL |

**No server-side validation** — missing required fields will produce degraded AI generation output, not a 400 error.

### Response — `200`

```json
{
  "success": true,
  "message": "Onboarded  successfully",
  "warning": "",
  "data": {
    "payload": {
      "userName": "string",
      "brandName": "string",
      "niche": "string",
      "purpose": "string",
      "targetAudience": "string",
      "description": "string",
      "website": "string",
      "channelId": "string",
      "userTitle": ["title1", "title2", "..."],
      "competitors": [
        {
          "url": "string",
          "id": "string",
          "titles": ["title1", "title2", "..."]
        }
      ],
      "websiteContent": "string",
      "stats": { "topics": 0, "scripts": 0 }
    }
  }
}
```

**When website scraping fails or no website provided:**
```json
{
  "warning": " Website content is not parsed"
}
```

**Partial enrichment failures are silent.** If a competitor channel lookup fails, that competitor's `id` is `""` and `titles` is `[]`. No error is surfaced — onboarding saves regardless.

### Error Cases

| Status | Condition |
|---|---|
| `500` | Firestore write failed (rare — save is in `finally` block) |

---

## GET `/v1/user/profile`

Returns the authenticated user's full profile document from Firestore.

### Auth
`Authorization: Bearer <token>` — required.

### Response — `200`

```json
{
  "success": true,
  "message": "Fetched onboarding data successfully",
  "data": {
    "userName": "string",
    "brandName": "string",
    "niche": "string",
    "purpose": "string",
    "targetAudience": "string",
    "description": "string",
    "website": "string",
    "channelId": "string",
    "userTitle": ["string"],
    "competitors": [
      { "url": "string", "id": "string", "titles": ["string"] }
    ],
    "websiteContent": "string",
    "stats": { "topics": 0, "scripts": 0 }
  }
}
```

Returns `{}` (empty object) if the user has no document yet (never onboarded).

### Error Cases

| Status | Condition |
|---|---|
| `500` | Firestore read failed |

---

## PATCH `/v1/user/profile`

Update profile fields. Runs the same full enrichment as onboarding (`formatUserData()`) — re-fetches YouTube data and re-scrapes the website if provided.

### Auth
`Authorization: Bearer <token>` — required.

### Request Body

Same shape as `PATCH /v1/user/onboarding`. Any subset of fields can be provided.

### Response — `200`

```json
{
  "success": true,
  "message": "Profile updated successfully",
  "data": {
    "payload": { "...enriched data..." }
  }
}
```

### Notes
- Re-runs full enrichment on every call — YouTube lookups and website scraping happen again even if only `brandName` changed. No diff or selective re-enrichment.

### Error Cases

| Status | Condition |
|---|---|
| `500` | Enrichment or Firestore update failed |

---

## User Document Schema

Stored in `users` Firestore collection. Document ID = Firebase UID.

| Field | Type | Description |
|---|---|---|
| `userName` | `string` | YouTube channel URL |
| `brandName` | `string` | Brand/channel name |
| `niche` | `string` | Content niche |
| `purpose` | `string` | Channel mission |
| `targetAudience` | `string` | Target audience |
| `description` | `string` | Channel description |
| `website` | `string` | Website URL (optional) |
| `channelId` | `string` | YouTube channel ID — empty string if lookup failed |
| `userTitle` | `string[]` | Creator's top 10 video titles — empty if lookup failed |
| `competitors` | `{ url, id, titles[] }[]` | Per-competitor data — `id`/`titles` empty if lookup failed |
| `websiteContent` | `string` | Scraped website text — empty string if scraping failed |
| `stats.topics` | `number` | Count of topics generated |
| `stats.scripts` | `number` | Count of scripts generated |

---

## Related Documentation

- [Onboarding Feature Spec](./spec.md)
- [Product Overview](../../product/overview.md)
- [Product Roadmap](../../product/roadmap.md)
