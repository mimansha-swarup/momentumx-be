# MomentumX — Parking Lot (deferred concerns)

> Strategic / sequencing concerns surfaced during the **Phase 3 zoom-out (2026-07-09)**.
> **Decision:** finish the planned Phase 3 work (Batch B: 3.2 prefill, 3.3 instant-first-idea,
> then 3.4/3.7/3.8) first; revisit each item below at the noted checkpoint.
> Companion to `implementation-phases.md` and `creator-saas-product-doc.md`.

---

## 1. Thumbnail image-gen spike hasn't started — **HIGH (critical path)**

- The product doc names thumbnail image generation as *"the one genuinely net-new,
  critical-path build."* The phase plan says the **P4 spike should start during P1**.
  It has not started.
- Riskiest unknown in the whole build: image **model choice**, **cost-per-image**,
  **quality for talking-head thumbnails**, and **watermarking infra** (free-tier taste).
- Thumbnail is both a **free door** and **the paid wow** — central to the conversion model.
- **Blocks on a product call:** image model + API access + per-image budget.
- **Revisit:** start the spike in parallel ASAP; the P4 *build* still waits for its slot,
  but the *investigation* shouldn't.

## 2. Core-loop output quality is unvalidated — **HIGH**

- The moat is context-*tuned generation*, but nothing so far verifies the generated
  **ideas / scripts / titles are actually good** for the ICP (business/finance/AI/
  productivity talking-head creators).
- For an AI product, output quality outranks plumbing correctness — and we're several
  phases into plumbing without an end-to-end quality check.
- **Recommended:** run a real channel through **onboard → idea → script → title →
  thumbnail brief** with live API keys and eyeball the output. Cheap; high signal.
- **Revisit:** as a gate before over-investing in more generation plumbing, and again
  before launch.

## 3. YouTube API is load-bearing and uncached — **MED (ops / cost)**

- Live YouTube calls on every request: onboarding (~2 calls per competitor), idea
  grounding (trending + keywords), title research. **No caching.**
- The degradation contract protects **correctness** (failures → empty block) but not
  **cost / latency / quota**. Likely the first ops wall at ICP scale.
- **Candidate fixes:** cache channel-id resolution (stable per URL), cache trending/
  keyword pools per niche with a short TTL.
- **Revisit:** around P4/P5 infra work, or at the first sign of quota pain.

## 4. Data-model debt — **LOW (consolidate at P6B)**

- `userName` field actually holds a **YouTube channel URL** (misleading name).
- `competitors` is typed `string[]` but stored as `{ url, id, titles }[]` (cast-through
  in `formatUserData`).
- `stats` constant in `src/constants/collection.ts` is now **orphaned** — no `src/`
  importer after the onboarding stats write was dropped (the `functions/` codebase
  keeps its own copy).
- **Revisit:** P6B trailing cleanup — consolidate names/types in one pass, not piecemeal.
