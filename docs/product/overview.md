---
title: "Product Overview"
last_updated: 2026-10-20
tags: ["product", "positioning", "overview"]
---

# Product Overview

**MomentumX is a YouTube creator workflow tool: “Trello for Creators — with AI built in.”** It helps creators choose ideas, research, write scripts, and prepare hooks, titles, descriptions, thumbnail concepts and Shorts. The value is connected, channel-specific work from idea to publish-ready assets.

The primary audience is growth-stage creators (roughly 1,000–50,000 subscribers) in business, finance, AI, productivity and educational niches, especially talking-head creators building a business or personal brand. Free access is intended to demonstrate the workflow to this audience. Channel format settings also support faceless output.

## Product model

**Projects are the container; tools are the entry points.** Creators can commit a generated idea, bring their own title, or enter through packaging. Projects retain relationships between script, hooks, title and packaging.

```text
Research / Idea → Script → Hooks → Title → Packaging
```

The default path is guided and jumpable: suggest a useful next step while allowing creators to revisit or enter later. Generation still needs appropriate input; hooks require a completed script step, while packaging can use supplied or stored content. The idea supplies a working project title; the selected optimized title is the publishing headline.

The workspace should show projects, current step, completion and stale state, and a clear continuation action. New creators should see an immediate Idea entry point; returning creators should be able to resume. Board, list or dashboard presentation remains a design choice.

The intended launch is one cohesive product with iteration and export throughout the flow. Locally completed capabilities do not establish that the production experience is ready.

## Context and first value

The intended onboarding experience delivers value before extensive setup: paste a YouTube channel URL, review inferred niche/audience/brand suggestions, try ideas, then enrich context over time. A manual niche-and-audience path supports creators without a channel URL. Connection uses public URLs; private analytics and OAuth are future work.

Context includes niche, audience, brand, format, own channel titles/description, competitors and website content when supplied. Channel membership controls access, so collaborators can work together regardless of who originally created an asset. See the [account contract](../multi-account/README.md).

Research belongs at the point of creation: evidence behind ideas and competitive/keyword context for titles and descriptions. A standalone analytics dashboard is outside intended launch scope. Research can be unavailable or cached; personalization and grounding do not guarantee output quality.

## Intended monetization

The intended business model is freemium with one subscription, provisionally **$9/month**. The paid value is continued use of the connected workflow. Intended trial: one full project, approximately five daily Ideas, and approximately two daily watermarked thumbnail images. Paid text was intended to be generous/fair-use, with approximately 50 unwatermarked images per month. These are pricing/packaging targets, not current API entitlements.

Current generation allowances use optional monthly credits. Reconcile those allowances with the proposed trial and paid plan before offering subscriptions. Payments and thumbnail image delivery remain outside current scope. See [current status and open work](./roadmap.md).

The intended primary conversion point is the free-project limit; watermarking is a secondary upgrade incentive, not a distribution strategy. Free-to-paid conversion is the intended business measure.

## Future direction and decisions

Distribution remains unresolved: select and validate channels that reach target creators, such as niche communities, content, referrals or partnerships. Workspace presentation and commercial quotas also need validation rather than being treated as shipped decisions.

Longer-term directions include a content calendar and scheduled/published lifecycle, reusable brand/assets, analytics-informed generation, directional AI refinement, a trend entry feed and cross-platform repurposing. Shared accounts and roles already exist locally; a broader agency product remains future work. This overview does not establish release status.

## Related documentation

- [Roadmap and locally implemented status](./roadmap.md)
- [Pipeline status model](./pipeline-spec.md)
- [Onboarding API](../features/onboarding/api.md)
- [API communication](../api-communication.md)
- [Operational readiness](../multi-account/operational-readiness.md)
