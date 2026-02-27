---
title: "Packaging API Reference"
description: "Endpoint reference for packaging generation, save, list, and retrieval."
date: 2026-02-27
last_updated: 2026-02-27
status: "draft"
tags: ["api", "packaging"]
---

# Packaging API Reference

All endpoints require `Authorization: Bearer <token>`.

Base path: `/v1/packaging`

> **Breaking change coming in Phase 0:** All generation endpoints currently take `{ script, title }` in the request body. In Phase 0 this will change to `{ videoProjectId }` — the server will pull script, title, and selectedHook from the video project. Plan frontend integrations accordingly.

---

## Endpoints Summary

| Method | URL | Purpose | Status |
|---|---|---|---|
| `POST` | `/v1/packaging/generate-title` | Generate 3 title variations | ✅ Built |
| `POST` | `/v1/packaging/generate-description` | Generate SEO description | ✅ Built |
| `POST` | `/v1/packaging/generate-thumbnail` | Generate 3 thumbnail briefs | ✅ Built |
| `POST` | `/v1/packaging/generate-hooks` | Generate 5 hooks (temporary) | ✅ Built |
| `POST` | `/v1/packaging/generate-shorts` | Generate Shorts script | ✅ Built |
| `POST` | `/v1/packaging/save` | Save packaging to Firestore | ✅ Built |
| `GET` | `/v1/packaging/list` | List user's packaging | ✅ Built |
| `GET` | `/v1/packaging/:packagingId` | Get single packaging | ✅ Built |

---

## POST `/v1/packaging/generate-title`

Generate 3 alternative title variations. Titles are 50–70 characters, search-optimized, using different emotional angles.

### Request Body
| Field | Type | Required |
|---|---|---|
| `script` | `string` | Yes |
| `title` | `string` | Yes |

### Response — `200`
```json
{
  "success": true,
  "data": {
    "titles": ["title1", "title2", "title3"]
  }
}
```

### Error Cases
- `500` — Gemini generation failed or JSON parse error

---

## POST `/v1/packaging/generate-description`

Generate an SEO-optimized YouTube description. Hook before "Show More", keywords woven naturally, timestamp placeholders, CTA. Target: 200–400 words.

### Request Body
| Field | Type | Required |
|---|---|---|
| `script` | `string` | Yes |
| `title` | `string` | Yes |

### Response — `200`
```json
{
  "success": true,
  "data": {
    "description": "full description text here"
  }
}
```

### Error Cases
- `500` — Gemini generation failed or JSON parse error

---

## POST `/v1/packaging/generate-thumbnail`

Generate 3 thumbnail design concepts. Each is a design brief (not a rendered image) with text overlay, visual layout description, and psychological hook.

### Request Body
| Field | Type | Required |
|---|---|---|
| `script` | `string` | Yes |
| `title` | `string` | Yes |

### Response — `200`
```json
{
  "success": true,
  "data": {
    "thumbnails": [
      {
        "concept": "concept name",
        "textOverlay": "3-5 words",
        "visualDescription": "layout and visual elements",
        "emotionalTrigger": "psychological hook explanation"
      }
    ]
  }
}
```

### Error Cases
- `500` — Gemini generation failed or JSON parse error

---

## POST `/v1/packaging/generate-hooks`

Generate 5 hook variations. **Temporary endpoint** — will move to `/v1/hooks/generate` in Phase 0. Do not build permanent dependencies on this path.

### Request Body
| Field | Type | Required |
|---|---|---|
| `script` | `string` | Yes |
| `title` | `string` | Yes |

### Response — `200`
```json
{
  "success": true,
  "data": {
    "hooks": ["hook1", "hook2", "hook3", "hook4", "hook5"]
  }
}
```

### Error Cases
- `500` — Gemini generation failed or JSON parse error

---

## POST `/v1/packaging/generate-shorts`

Generate a YouTube Shorts script. Target: under 60 seconds, structured as hook / body / CTA.

### Request Body
| Field | Type | Required |
|---|---|---|
| `script` | `string` | Yes |
| `title` | `string` | Yes |

### Response — `200`
```json
{
  "success": true,
  "data": {
    "shortsScript": {
      "hook": "opening 3 seconds",
      "body": "main content",
      "callToAction": "closing 5 seconds",
      "estimatedDuration": "52 seconds"
    }
  }
}
```

### Error Cases
- `500` — Gemini generation failed or JSON parse error

---

## POST `/v1/packaging/save`

Save a packaging document to Firestore. Document ID is Firestore auto-generated. Client controls which fields are included. `createdBy`, `createdAt`, `updatedAt` are set server-side.

**No foreign keys:** The saved document will have no `scriptId`, `topicId`, or `videoProjectId`. Packaging is disconnected until Phase 0.

### Request Body
Any packaging fields to persist. No fixed schema enforced.

### Response — `201`
```json
{
  "success": true,
  "data": {
    "id": "firestore-auto-id"
  }
}
```

### Error Cases
- `500` — Firestore write failed

---

## GET `/v1/packaging/list`

List all packaging documents for the authenticated user, ordered by `createdAt` descending.

### Response — `200`
```json
{
  "success": true,
  "data": [
    {
      "id": "string",
      "createdBy": "string",
      "createdAt": "<timestamp>",
      "updatedAt": "<timestamp>"
    }
  ]
}
```

Additional fields per document depend on what was passed to `/save`. No fixed schema enforced on read.

### Error Cases
- `500` — Firestore read failed

---

## GET `/v1/packaging/:packagingId`

Get a single packaging document. Ownership is enforced — `createdBy` must match the requesting user.

**Known inconsistency:** Ownership failure throws `Error('Unauthorized')` which surfaces as a 500, not a 403. To be fixed when error codes are standardized across the API.

### Path Parameters
| Param | Type | Description |
|---|---|---|
| `packagingId` | `string` | Firestore auto-generated document ID |

### Response — `200`
```json
{
  "success": true,
  "data": {
    "id": "string",
    "createdBy": "string",
    "createdAt": "<timestamp>",
    "updatedAt": "<timestamp>"
  }
}
```

### Error Cases
- `500` — document not found, ownership check failed, or Firestore read failed (all return 500 currently)

---

## Related Documentation

- [Packaging Feature Spec](./spec.md)
- [Hooks Feature Spec](../hooks/spec.md)
- [Pipeline Spec](../../product/pipeline-spec.md)
- [Product Roadmap](../../product/roadmap.md)
