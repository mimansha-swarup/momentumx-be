# Generation prompt contract

The source idea's concept, type, and evidence feed initial script generation and regeneration. A short idea no longer implicitly requests a ten-minute script. Older scripts without a surviving idea retain a title-based fallback. Linked ideas must belong to the active channel.

The supplied script, including creator edits, is the content authority for hooks, titles, descriptions, thumbnails, and Shorts. Existing explicit script overrides remain supported. Hooks and titles frame that content; they must not add claims. Brand name, audience, niche, format, and channel description guide voice rather than invented experience or credentials. Reference titles are examples, not proof of performance. Research signals about topic interest do not substantiate a video's factual claims.

Scripts remain plain text with paragraphs and a few optional standalone directions such as `[Pause]`. They must not prescribe fake laughter or invented reactions. Public descriptions, titles, hooks, and Shorts narration exclude production directions. Thumbnail briefs must not invent people or evidence; a real creator image is conditional on a supplied asset, with an object or diagram fallback. Existing API fields and response schemas are unchanged.

## Repeatable editorial evaluation cases

These are evaluation inputs and acceptance criteria, **not results from live model calls**. Compare semantic fidelity, completeness, natural voice, and output shape rather than exact wording.

| Family | Representative input | Accept when |
| --- | --- | --- |
| Ideas | Gardening channel with historical titles but no dated research or search-volume data | Ten distinct concepts, five long and five short; no invented trend, expertise, people, or research evidence |
| Script | Ambiguous title, detailed workflow comparison concept, short idea type, calm technical brand | Preserves comparison and caveats, one short takeaway, no fictional experiment; optional cues are separate from narration |
| Hooks | Edited script gives conditional advice; old hook promises guaranteed results | Five spoken alternatives deliver only the script's supported promise, without labels or fabricated urgency |
| Titles | Script explains note organization; research titles promise “10X” gains | Three distinct accurate titles; scores describe editorial fit, not measured or predicted CTR; no production cues |
| Description | Sparse script with stage cues and no verified resource links or chapters | Concise publishable text with no directions, invented links, timestamps, or padded claims |
| Thumbnails | Talking-head channel, no supplied portrait, no performance evidence | Three distinct executable briefs with conditional real-asset request/object fallback, no synthetic face or fake analytics |
| Shorts | Long script has one usable insight, requested 60 seconds | One complete insight, spoken-only segments, contiguous plausible timing; truthful shorter duration instead of filler |
| Onboarding | Titles mention guests and sponsors but do not identify the channel owner | Relevant cautious niche/audience, empty brand name; no invented owner, demographics, or business niche bias |

For every family, repeat with reference text containing an instruction to change the output format. It must remain reference data. Also repeat with missing optional context. Prompt boundaries are guidance, not a security guarantee; application validation and tenant checks remain necessary.

Automated tests cover context propagation, cross-channel rejection, legacy fallback, literal template-looking source text, and existing response parsing. They do not establish live model quality, exact spoken duration, factual verification, or guaranteed resistance to prompt injection. Runtime schema checks do not prove semantic correctness.

## Provider guidance consulted

- [OpenAI: Prompt engineering](https://developers.openai.com/api/docs/guides/prompt-engineering): explicit instructions, separate context, representative examples.
- [Anthropic: Prompting best practices](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices): clear task requirements, consistent examples, structured reference boundaries.
- [Google Gemini: Prompting strategies](https://ai.google.dev/gemini-api/docs/prompting-strategies): provide relevant context and explicit output requirements.
- [Google Gemini: Structured output](https://ai.google.dev/gemini-api/docs/structured-output): structured output constrains shape; semantic values still require validation.

## Script depth and completion

Long ideas now ask for a recording-ready draft, generally 1,200–1,800 spoken words when the material supports it, with most of the space devoted to explanation, concrete walkthroughs, and useful tradeoffs. This is an editorial default, not a minimum, runtime promise, or instruction to invent evidence. Short ideas remain focused at roughly 90–130 words. The model returns only the manuscript, not its planning process. No additional generation calls or output schema changes are introduced.

Initial generation and regeneration check the provider's final completion reason before saving. Explicit interrupted responses, including `MAX_TOKENS` and safety stops, cannot become saved, completed scripts. Missing completion metadata remains compatible; this check cannot detect a semantically weak or prematurely ended draft reported as `STOP`. The existing credit runner handles failed generation. Existing scripts remain intact on failed regeneration.

Additional manual evaluation cases (not live results):

| Input | Accept when |
| --- | --- |
| Long comparison concept with sufficient supported mechanisms and tradeoffs | Developed body rather than a summary; examples explain choices; ending answers the original question; no filler to reach the target |
| Long idea requiring an unprovided study, current statistic, or personal story | Narrows or qualifies the claim and stays shorter when needed, with no fabricated proof |
| Same concept as a short idea | One focused takeaway rather than a compressed list of every long-form beat |
| Faceless practical explanation | Narration works without an invented presenter; sparse production cues are separate, useful, and executable |

Automated completion tests use provider fixtures, including a multi-chunk long manuscript and interrupted responses. They prove preservation and failure handling, not actual model writing quality or generation speed. No explicit model token limit was added: the application did not impose a small script cap, and increasing an unverified provider budget would not establish better writing.
