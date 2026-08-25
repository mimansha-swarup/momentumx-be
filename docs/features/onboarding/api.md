---
title: "Onboarding — API Reference"
description: "Endpoint reference for onboarding, profile retrieval, and profile update"
date: 2026-02-27
last_updated: 2026-03-17
status: "implemented"
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

**Every field is individually optional.** The requirement is a *cross-field* one,
enforced by `onboardingSchema` (`src/validation/user.validation.ts`):

> Provide a **YouTube channel URL**, or **both a niche and a target audience**.

Two entry paths, deliberately low-friction — with a channel URL we enrich the rest
from it, so the fastest onboarding is a single field.

| Field | Type | Required | Description |
|---|---|---|---|
| `userName` | `string` | Conditional | Creator's YouTube channel URL. Satisfies the requirement on its own. |
| `niche` | `string` | Conditional | Content niche. Required only when `userName` is absent, together with `targetAudience`. |
| `targetAudience` | `string` | Conditional | Target audience description. Same condition as `niche`. |
| `brandName` | `string` | No | Brand or channel name |
| `purpose` | `string` | No | Channel purpose / mission |
| `competitors` | `string[]` | Yes | Array of competitor YouTube channel URLs |
| `description` | `string` | Yes | Channel description |
| `website` | `string` | No | Brand/personal website URL |

**Server-side validation is enforced.** This section previously said there was none —
that is no longer true. `validate(onboardingSchema)` runs before the controller:

- Failing the cross-field rule above returns **400** with a field-prefixed message.
- Every field is length-capped (`brandName`/`niche` 200, `targetAudience` 500,
  `purpose` 1000, `description` 5000, URLs 2000, `competitors` max 20).
- `userName` and each `competitors[]` entry must look like a YouTube channel URL;
  `website` must be a valid `http(s)` URL or an empty string.
- `format` must be `talking_head` or `faceless`.
- **Unknown keys are stripped**, so derived/enrichment fields cannot be injected by
  a client.

What is still true: supplying only the bare minimum yields thinner AI output. That is
a quality consequence, not a validation error.

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
      "stats": { "ideas": 0, "scripts": 0 }
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
    "stats": { "ideas": 0, "scripts": 0 }
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
| `stats.ideas` | `number` | Count of ideas generated |
| `stats.scripts` | `number` | Count of scripts generated |

---

## Related Documentation

- [Onboarding Feature Spec](./spec.md)
- [Product Overview](../../product/overview.md)
- [Product Roadmap](../../product/roadmap.md)
