import type { CreditReservation } from "../repository/billing.repository.js";
import {
  PACKAGING_SYSTEM_PROMPT,
  GENERATE_TITLE_PROMPT,
  GENERATE_DESCRIPTION_PROMPT,
  GENERATE_THUMBNAIL_PROMPT,
  GENERATE_SHORTS_PROMPT,
} from "../constants/prompt.js";
import {
  GENERATION_CONFIG_TITLE_VARIATIONS,
  GENERATION_CONFIG_SHORTS,
  GENERATION_CONFIG_DESCRIPTION,
  GENERATION_CONFIG_THUMBNAIL,
} from "../constants/firebase.js";
import { GenerationConfig } from "@google/generative-ai";
import PackagingRepository from "../repository/packaging.repository.js";
import VideoProjectService from "./video-project.service.js";
import StepRunner from "./step-runner.js";
import ContextService from "./context.service.js";
import ResearchContextService from "./research-context.service.js";
import { collectJson, generateStreamingContent } from "../utlils/ai.js";
import { firebase } from "../config/firebase.js";
import { BadRequest, Forbidden, NotFound, ServiceUnavailable } from "../utlils/errors.js";
import { forbidCrossAccount } from "./account.service.js";
import AccountRepository from "../repository/account.repository.js";
import { IPackagingItemStatuses } from "../types/routes/video-project.js";
import { PackagingItemName } from "../types/routes/packaging.js";
import { RecordOwner } from "../utlils/content.js";
import { IChannelContext } from "../types/routes/context.js";
import {
  buildCreatorContextBlock,
  buildHookSection,
  buildScriptSection,
  fillTemplate,
  THUMBNAIL_FORMAT_DIRECTIVE,
  resolveVideoFormat,
} from "../utlils/prompt-blocks.js";

interface IGenerationInputs {
  channel: IChannelContext | null;
  script: string;
  hook: string;
  workingTitle: string | null;
}

class PackagingService {
  private repo: PackagingRepository;

  constructor(
    repo: PackagingRepository,
    private videoProjectService: VideoProjectService,
    private contextService: ContextService,
    private accounts: AccountRepository,
    private researchContext: ResearchContextService | undefined,
    private steps: StepRunner
  ) {
    this.repo = repo;
  }

  // Best-available context (phases 1D): channel context always, script/hook
  // resolved server-side from the project when not supplied by the client.
  // An explicit body script wins over the stored one (supports edited-but-
  // unsaved scripts and keeps existing calls behaving identically).
  private resolveGenerationInputs = async (
    owner: RecordOwner,
    videoProjectId?: string,
    explicitScript?: string
  ): Promise<IGenerationInputs> => {
    const ctx = await this.contextService.assemble(
      owner,
      videoProjectId ? { videoProjectId } : {}
    );
    return {
      channel: ctx.channelContext,
      script: explicitScript?.trim()
        ? explicitScript
        : ctx.sessionContext.script ?? "",
      hook: ctx.sessionContext.selectedHook ?? "",
      workingTitle: ctx.sessionContext.workingTitle,
    };
  };

  // config is required (no schema-less default): every packaging generation must
  // pass a responseSchema-enforced config. collectJson handles the three ways a
  // generation can fail — blocked stream, empty body, unparseable body — as a 503
  // the client can show and retry, instead of a masked 500.
  private generateContent = async (
    userPrompt: string,
    config: GenerationConfig,
    // Names the item in the user-facing failure message ("Couldn't generate a
    // description — …"); a generic "content" tells them nothing about what to retry.
    label: string
  ) => {
    const result = await generateStreamingContent(
      PACKAGING_SYSTEM_PROMPT,
      userPrompt,
      config
    );

    return collectJson<unknown>(result, label);
  };

  // The post-script Title step (phase 2C): script + hook + channel context +
  // live competitive title research → 3 scored variations. Research query =
  // the project's working title when available (specific beats broad), else
  // the script's opening. Research failure degrades to context-only titles.
  private runTitle = async (owner: RecordOwner, script?: string, videoProjectId?: string) => {
    const inputs = await this.resolveGenerationInputs(owner, videoProjectId, script);
    if (!inputs.script) {
      throw BadRequest("Script is required — provide one or use a project with a generated script");
    }

    let researchSignals = "";
    if (this.researchContext) {
      const query = inputs.workingTitle || inputs.script.slice(0, 120);
      researchSignals = await this.researchContext.getTitleSignals(query);
    }

    const userPrompt = fillTemplate(GENERATE_TITLE_PROMPT, {
      "{creatorContext}": buildCreatorContextBlock(inputs.channel),
      "{researchSignals}": researchSignals,
      "{script}": inputs.script,
      "{hookSection}": buildHookSection(inputs.hook),
    });
    return this.generateContent(userPrompt, GENERATION_CONFIG_TITLE_VARIATIONS, "titles");
  };

  private runDescription = async (
    owner: RecordOwner,
    script: string | undefined,
    title: string,
    videoProjectId?: string
  ) => {
    const inputs = await this.resolveGenerationInputs(owner, videoProjectId, script);
    const userPrompt = fillTemplate(GENERATE_DESCRIPTION_PROMPT, {
      "{title}": title,
      "{creatorContext}": buildCreatorContextBlock(inputs.channel),
      "{scriptSection}": buildScriptSection(inputs.script),
      "{hookSection}": buildHookSection(inputs.hook),
    });
    return this.generateContent(userPrompt, GENERATION_CONFIG_DESCRIPTION, "a description");
  };

  private runThumbnail = async (
    owner: RecordOwner,
    script: string | undefined,
    title: string,
    videoProjectId?: string
  ) => {
    const inputs = await this.resolveGenerationInputs(owner, videoProjectId, script);
    const format = resolveVideoFormat(inputs.channel?.format);
    const userPrompt = fillTemplate(GENERATE_THUMBNAIL_PROMPT, {
      "{title}": title,
      "{formatDirective}": THUMBNAIL_FORMAT_DIRECTIVE[format],
      "{creatorContext}": buildCreatorContextBlock(inputs.channel),
      "{scriptSection}": buildScriptSection(inputs.script),
      "{hookSection}": buildHookSection(inputs.hook),
    });
    return this.generateContent(userPrompt, GENERATION_CONFIG_THUMBNAIL, "thumbnail briefs");
  };

  private runShorts = async (owner: RecordOwner, script: string | undefined, duration: number, videoProjectId?: string) => {
    // Script is pipeline-native but resolved server-side: an explicit body
    // script wins, else it's pulled from the project (best-available context).
    const inputs = await this.resolveGenerationInputs(owner, videoProjectId, script);
    if (!inputs.script) {
      throw BadRequest("Provide a script or a videoProjectId with a generated script");
    }
    const userPrompt = fillTemplate(GENERATE_SHORTS_PROMPT, {
      "{creatorContext}": buildCreatorContextBlock(inputs.channel),
      "{script}": inputs.script,
      "{duration}": duration.toString(),
    });
    return this.generateContent(userPrompt, GENERATION_CONFIG_SHORTS, "a Shorts script");
  };

  // Public generation PERSISTS straight to the packaging doc (creating it on the
  // first generation for a project) — the client never round-trips generated
  // content back through /save. Each returns the persisted content plus the
  // packagingId. Without a videoProjectId it's a stateless preview (no persist).
  generateTitle = async (owner: RecordOwner, script?: string, videoProjectId?: string) => {
    return this.steps.run({ actor: owner, kind: "title", projectId: videoProjectId }, async (charge) => {
      const raw = await this.runTitle(owner, script, videoProjectId);
      this.rejectEmptyGeneration("title", raw);
      if (!videoProjectId) return raw;
      const { packagingId, canonical } = await this.persistGeneratedItem(owner, videoProjectId, "title", raw, ...(charge ? [charge] as const : []));
      return { titles: canonical, packagingId };
    });
  };

  generateDescription = async (
    owner: RecordOwner,
    script: string | undefined,
    title: string,
    videoProjectId?: string
  ) => {
    return this.steps.run({ actor: owner, kind: "description", projectId: videoProjectId }, async (charge) => {
      const raw = await this.runDescription(owner, script, title, videoProjectId);
      this.rejectEmptyGeneration("description", raw);
      if (!videoProjectId) return raw;
      const { packagingId, canonical } = await this.persistGeneratedItem(owner, videoProjectId, "description", raw, ...(charge ? [charge] as const : []));
      return { description: canonical, packagingId };
    });
  };

  generateThumbnail = async (
    owner: RecordOwner,
    script: string | undefined,
    title: string,
    videoProjectId?: string
  ) => {
    return this.steps.run({ actor: owner, kind: "thumbnail", projectId: videoProjectId }, async (charge) => {
      const raw = await this.runThumbnail(owner, script, title, videoProjectId);
      this.rejectEmptyGeneration("thumbnail", raw);
      if (!videoProjectId) return raw;
      const { packagingId, canonical } = await this.persistGeneratedItem(owner, videoProjectId, "thumbnail", raw, ...(charge ? [charge] as const : []));
      return { descriptions: canonical, packagingId };
    });
  };

  generateShorts = async (owner: RecordOwner, script: string | undefined, duration: number, videoProjectId?: string) => {
    return this.steps.run({ actor: owner, kind: "shorts", projectId: videoProjectId }, async (charge) => {
      const raw = await this.runShorts(owner, script, duration, videoProjectId);
      this.rejectEmptyGeneration("shorts", raw);
      if (!videoProjectId) return raw;
      const { packagingId, canonical } = await this.persistGeneratedItem(owner, videoProjectId, "shorts", raw, ...(charge ? [charge] as const : []));
      return { ...(canonical as Record<string, unknown>), packagingId };
    });
  };

  // Persist one freshly generated item into the project's packaging doc and
  // advance the right pipeline step. Title is its own step (generating starts it,
  // SELECTING completes it — see selectTitle); description/thumbnail/shorts are
  // the packaging step, which completes once all THREE exist. The create-or-update
  // + status snapshot is a single atomic repo transaction so two generations
  // racing can't split into two docs or both skip completion. Content write is
  // critical; pipeline transitions are best-effort (logged), matching savePackaging.
  /**
   * Reject an unusable generation BEFORE the preview/persist branch.
   *
   * `isEmptyField` already guarded the persist path (inside `persistGeneratedItem`),
   * but the stateless preview returns `raw` and never reaches it — so a model that
   * produced "" was billed as a success and handed back as an empty result. The
   * reservation is only released if we throw, which is why this must run before the
   * early return, not after it.
   *
   * 503, matching the persist path: the client did nothing wrong, the model did, and
   * a retryable status is what lets the caller try again.
   */
  private rejectEmptyGeneration = (item: PackagingItemName, raw: unknown): void => {
    const field = item === "title" ? "titles" : item;
    if (this.isEmptyField(field, this.normalizeField(field, raw))) {
      throw ServiceUnavailable(`Couldn't generate the ${item}. Please try again.`);
    }
  };

  private persistGeneratedItem = async (
    owner: RecordOwner,
    videoProjectId: string,
    item: PackagingItemName,
    rawContent: unknown,
    charge?: CreditReservation | null
  ): Promise<{ packagingId: string; canonical: unknown }> => {
    const { userId } = owner;
    // Ownership check (throws if the project isn't the caller's).
    await this.videoProjectService.getById(videoProjectId, owner);

    // Storage field == item name, except title lives under "titles". Normalize
    // BEFORE the write so malformed content throws here (no orphaned doc).
    const field = item === "title" ? "titles" : item;
    const canonical = this.normalizeField(field, rawContent);
    // Refuse USABLE-LOOKING but empty output before anything is persisted.
    //
    // `{"description":""}` satisfies the response schema and passes
    // `normalizeField`, which only checks the TYPE. Persisting it marked the item
    // completed, kept the charge, and — when regenerating over existing content —
    // destroyed the text it replaced. `isEmptyField` already encoded "unusable"
    // for the manual-save path; it just was not on the generate path.
    //
    // 503 rather than 400: the client did nothing wrong, the model did, and a
    // retryable status is what lets the caller try again. Thrown BEFORE the write,
    // so `step-runner` releases the reservation and the user is not charged.
    if (this.isEmptyField(field, canonical)) {
      throw ServiceUnavailable(`Couldn't generate the ${item}. Please try again.`);
    }

    const { packagingId, created, statuses } = await this.repo.upsertGeneratedItem(
      videoProjectId,
      owner,
      field,
      item,
      canonical, ...(charge ? [charge] as const : [])
    );
    const step = item === "title" ? "title" : "packaging";

    // Pipeline sync is best-effort: the content is already saved, so a transition
    // hiccup must not fail generation.
    try {
      if (created) {
        await this.videoProjectService.linkResource(videoProjectId, "packaging", packagingId, owner, ...(charge ? [charge] as const : []));
      }
      await this.videoProjectService.startStep(videoProjectId, step, owner, ...(charge ? [charge] as const : []));
      // Packaging completes when its three items exist; the title step completes
      // on selection, never here.
      if (step === "packaging" &&
        statuses.description === "completed" &&
        statuses.thumbnail === "completed" &&
        statuses.shorts === "completed"
      ) {
        await this.videoProjectService.completeStep(videoProjectId, "packaging", owner, ...(charge ? [charge] as const : []));
      }
    } catch (pipelineError) {
      console.error(JSON.stringify({ event: "pipeline_transition_failed", step, projectId: videoProjectId, packagingId, item, userId, message: (pipelineError as Error)?.message }));
    }

    return { packagingId, canonical };
  };

  // The four packaging content fields, in their canonical stored shapes:
  //   titles      -> Array<{ title, characterCount }>
  //   description -> string
  //   thumbnail   -> string[]   (the generator's `descriptions` briefs)
  //   shorts      -> { segments, totalDuration }
  // Generators return these wrapped (e.g. { titles: [...] }, { descriptions: [...] }),
  // and the FE save path is not solidified, so we coerce wrapper-or-bare input to the
  // canonical value at every write. Malformed input throws (never persist junk/undefined).
  private static readonly ITEM_FIELDS = ["titles", "description", "thumbnail", "shorts"] as const;

  private normalizeField = (field: string, raw: unknown): unknown => {
    const wrapper = (raw ?? {}) as Record<string, unknown>;
    switch (field) {
      case "titles": {
        const v = Array.isArray(raw) ? raw : wrapper.titles;
        if (!Array.isArray(v)) throw BadRequest("titles must be an array");
        return v;
      }
      case "description": {
        const v = typeof raw === "string" ? raw : wrapper.description;
        if (typeof v !== "string") throw BadRequest("description must be a string");
        return v;
      }
      case "thumbnail": {
        const v = Array.isArray(raw) ? raw : wrapper.descriptions;
        if (!Array.isArray(v)) throw BadRequest("thumbnail must be an array of briefs");
        return v;
      }
      case "shorts": {
        const v = Array.isArray(wrapper.segments) ? raw : wrapper.shorts;
        if (!v || !Array.isArray((v as Record<string, unknown>).segments)) {
          throw BadRequest("shorts must include a segments array");
        }
        return v;
      }
      default:
        return raw;
    }
  };

  // "Meaningful text" = a non-blank string. Titles/segments carry their text in
  // an object field (`title` / `content`); thumbnail briefs are bare strings.
  // Shared by every array/object branch below so a blank-but-schema-valid
  // response (all elements present, all text empty) reads as empty too.
  private hasText = (value: unknown): boolean =>
    typeof value === "string" && value.trim().length > 0;

  private isEmptyField = (field: string, value: unknown): boolean => {
    if (value == null) return true;
    if (field === "shorts") {
      const segments = (value as { segments?: unknown[] }).segments;
      if (!Array.isArray(segments) || segments.length === 0) return true;
      return !segments.some((s) => this.hasText((s as { content?: unknown })?.content));
    }
    if (Array.isArray(value)) {
      if (value.length === 0) return true;
      if (field === "titles") {
        return !value.some((t) =>
          this.hasText(typeof t === "string" ? t : (t as { title?: unknown })?.title)
        );
      }
      // thumbnail (and any other bare-string array field)
      return !value.some((v) => this.hasText(v));
    }
    if (typeof value === "string") return value.trim() === "";
    return false;
  };

  private buildItemStatuses = (data: Record<string, unknown>) => {
    const hasContent = (key: string) => {
      const val = data[key];
      if (val === undefined || val === null) return false;
      if (Array.isArray(val)) return val.length > 0;
      if (typeof val === "string") return val.trim().length > 0;
      return true;
    };

    return {
      title: hasContent("titles") ? "completed" as const : "not_started" as const,
      description: hasContent("description") ? "completed" as const : "not_started" as const,
      thumbnail: hasContent("thumbnail") ? "completed" as const : "not_started" as const,
      shorts: hasContent("shorts") ? "completed" as const : "not_started" as const,
    };
  };

  // A door-saved package has no project title; use its first generated title as
  // the shallow project's working title, else a neutral placeholder.
  private deriveWorkingTitle = (data: Record<string, unknown>): string => {
    const titles = data.titles;
    if (Array.isArray(titles) && titles.length > 0) {
      const first = titles[0];
      if (typeof first === "string" && first.trim()) return first.trim();
      if (first && typeof first === "object") {
        const t = (first as { title?: unknown }).title;
        if (typeof t === "string" && t.trim()) return t.trim();
      }
    }
    return "Untitled video";
  };

  savePackaging = async (owner: RecordOwner, data: Record<string, unknown>, videoProjectId?: string) => {
    const { userId } = owner;
    // Coerce any present content field to its canonical stored shape so the
    // persisted doc matches what regenerateItem and the readers expect.
    const normalized: Record<string, unknown> = { ...data };
    // Never persist script/hooks snapshots: nothing reads them (generation
    // resolves both from the project), and clients used to send empty ones.
    delete normalized.script;
    delete normalized.hooks;
    for (const field of PackagingService.ITEM_FIELDS) {
      if (field in data && data[field] != null) {
        normalized[field] = this.normalizeField(field, data[field]);
      }
    }
    // Snapshot BEFORE dropping "unhydrated blank" fields below: the selected-title
    // validation further down must see what the caller actually submitted (so a
    // blank/invalid title paired with a selectedTitleIndex still 400s), not the
    // post-drop state where that same content has already been discarded as empty.
    const submitted = { ...normalized };
    for (const field of PackagingService.ITEM_FIELDS) {
      // A save carries EDITS, and empty content is never an edit — it's a client
      // that hasn't hydrated yet posting its blank initial state (the Title screen
      // sends the whole snapshot, including a description it may not have loaded).
      // Writing that would wipe generated content. No UI offers "clear this field",
      // so dropping empties costs nothing.
      if (this.isEmptyField(field, normalized[field])) delete normalized[field];
    }

    // Door model (§0 / 6A.3): packaging is NEVER a standalone doc. Given a
    // project, use it (ownership-checked); with none, lazily spin up a shallow
    // one (idea + project from the packaged title) so the work is captured into
    // the pipeline. Either branch leaves us with a project for the save below.
    let projectId = videoProjectId;
    if (projectId) {
      await this.videoProjectService.getById(projectId, owner);
    } else {
      const project = await this.videoProjectService.createFromTitle(
        owner,
        this.deriveWorkingTitle(normalized)
      );
      projectId = project.id;
    }

    const packagingData = {
      ...normalized,
      // AFTER the spread, like createdBy — though packagingSaveSchema, not field
      // order, is what stops these keys reaching the service at all.
      createdBy: owner.userId,
      accountId: owner.accountId,
      videoProjectId: projectId,
    };

    // Stale flags are set fresh ONLY when the document is first created — a
    // brand-new package is never stale. On update (re-save) we must NOT touch
    // them: a plain re-save would otherwise silently un-stale a package that
    // an upstream regenerate had marked stale. Genuine un-staling happens via
    // regenerateItem → refreshPackagingStep.
    const freshStaleFlags = { isStale: false, staleReason: null, staleSince: null };

    // Upsert: reuse the existing package for this project, else create one.
    // itemStatuses is written on CREATE only. buildItemStatuses knows nothing but
    // "does this field have content", so recomputing it on update would rewrite a
    // "stale" item back to "completed" — and with auto-save firing on every edit
    // and thumbnail click, an ordinary keystroke would silently un-stale the whole
    // package. Generation/regeneration own those statuses after creation.
    const existing = await this.repo.get(projectId);
    const merged = { ...(existing ?? {}), ...normalized } as Record<string, unknown>;
    // Validated against `submitted` (pre-drop), not `merged` — see the comment
    // at the snapshot above.
    const mergedForValidation = { ...(existing ?? {}), ...submitted } as Record<string, unknown>;
    let selectedTitle: string | undefined;
    if (("titles" in submitted || "selectedTitleIndex" in submitted)
      && mergedForValidation.selectedTitleIndex != null) {
      const index = mergedForValidation.selectedTitleIndex;
      if (typeof index !== "number" || !Number.isInteger(index) || index < 0
        || !Array.isArray(mergedForValidation.titles) || index >= mergedForValidation.titles.length) {
        throw BadRequest("Invalid title index");
      }
      const selected = mergedForValidation.titles[index];
      const text = typeof selected === "string" ? selected : selected?.title;
      if (typeof text !== "string" || !text.trim()) {
        throw BadRequest("Selected title has no text");
      }
      selectedTitle = text.trim();
    }
    let result: Record<string, unknown>;
    if (existing) {
      // `projectId`, not `existing.id as string`. The packaging document is
      // keyed on the video project by construction (firestore-conventions.md),
      // so these are the same value and the cast said nothing.
      //
      // An earlier version of this comment claimed `repo.get` "never stamps
      // `id`" — it does: both `saveWithId` and `upsertGeneratedItem` write
      // `id` INTO the document data, so `existing.id` was always defined. The
      // change is a clarity fix, not a bug fix, and the comment should not have
      // claimed otherwise.
      result = await this.repo.update(projectId, {
        ...packagingData,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      });
    } else {
      result = await this.repo.saveWithId(projectId, {
        ...packagingData,
        itemStatuses: this.buildItemStatuses(normalized),
        ...freshStaleFlags,
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      });
    }

    // Keep the selected title and project name in this account-scoped request.
    // This failure must surface: retry repeats the rename even if the package
    // already contains the edit. Only selectTitle completes the Title step.
    if (selectedTitle !== undefined) {
      await this.videoProjectService.update(projectId, owner, { title: selectedTitle });
    }

    // Completion is earned by CONTENT, never by the act of saving. A save is an
    // edit, and edits arrive from the Title screen too — unconditionally completing
    // here marked packaging done (and the project finished) the moment someone
    // renamed a title variation, with no description, thumbnail or Shorts written.
    // Same rule persistGeneratedItem uses: the three packaging items must exist.
    const settled = this.buildItemStatuses(merged);
    const packagingComplete =
      settled.description === "completed" &&
      settled.thumbnail === "completed" &&
      settled.shorts === "completed";

    try {
      await this.videoProjectService.linkResource(projectId, "packaging", result.id as string, owner);
      // And even with all three present, a STALE package stays stale: completeStep
      // moves `stale` straight to `completed`, so an edit-save would clear the
      // project's stale badge without anything being regenerated. Un-staling is an
      // explicit act — regenerate the item, or the banner's "Keep as-is" (which
      // calls completeStep directly).
      // A door-created (or never-started) project has packaging still not_started,
      // which completeStep rejects — start it first (startStep no-ops if already
      // in_progress/completed), so both the door and pipeline paths complete cleanly.
      if (packagingComplete && !existing?.isStale) {
        await this.videoProjectService.startStep(projectId, "packaging", owner);
        await this.videoProjectService.completeStep(projectId, "packaging", owner);
      }
    } catch (pipelineError) {
      console.error(JSON.stringify({ event: "pipeline_transition_failed", step: "packaging", projectId, packagingId: result.id, userId, message: (pipelineError as Error)?.message }));
    }
    return result;
  };

  getPackaging = async (packagingId: string, owner: RecordOwner) => {
    const result = await this.repo.get(packagingId);
    if (!result) return null;
    if (result.accountId !== owner.accountId)
      await forbidCrossAccount(this.accounts, result.accountId, owner);
    return result;
  };

  getPackagingByAccount = async (owner: RecordOwner) => {
    return this.repo.getByAccountId(owner.accountId);
  };

  // Title continuity (§7.3): the user finalizes one of the generated Title
  // variations. Persist the choice and promote it to the project's display title
  // (the idea working-title was only ever a placeholder).
  selectTitle = async (owner: RecordOwner, packagingId: string, index: number) => {
    const { userId } = owner;
    const pkg = await this.repo.get(packagingId);
    if (!pkg) {
      throw NotFound("Packaging not found");
    }
    if (pkg.accountId !== owner.accountId) {
      await forbidCrossAccount(this.accounts, pkg.accountId, owner);
    }
    if (!Array.isArray(pkg.titles) || pkg.titles.length === 0) {
      throw BadRequest("No titles have been generated for this packaging");
    }
    if (!Number.isInteger(index) || index < 0 || index >= pkg.titles.length) {
      throw BadRequest("Invalid title index");
    }
    const titleText = pkg.titles[index]?.title?.trim();
    if (!titleText) {
      throw BadRequest("Selected title has no text");
    }

    await this.repo.update(packagingId, { selectedTitleIndex: index });

    // Title continuity (§7.3): promote the chosen title to the project's display
    // name. Owning project from the STORED doc, never the client (api-design rule).
    // NOT best-effort — the rename IS the feature, so a failure must surface (→ FE
    // toast → retry, which is idempotent) rather than be silently swallowed.
    if (pkg.videoProjectId) {
      await this.videoProjectService.update(pkg.videoProjectId, owner, { title: titleText });
      // Selecting a title IS the completion of the Title pipeline step. Best-effort
      // (like other pipeline transitions) so a step hiccup can't fail the rename.
      try {
        await this.videoProjectService.completeStep(pkg.videoProjectId, "title", owner);
      } catch (stepError) {
        console.error(JSON.stringify({ event: "pipeline_transition_failed", step: "title", projectId: pkg.videoProjectId, packagingId, userId, message: (stepError as Error)?.message }));
      }
    }

    return { id: packagingId, selectedTitleIndex: index, title: titleText };
  };

  regenerateItem = async (
    owner: RecordOwner,
    packagingId: string,
    item: string,
    script?: string,
    title?: string,
    duration?: number
  ) => {
    const { userId } = owner;
    const pkg = await this.repo.get(packagingId);
    if (!pkg) {
      throw NotFound("Packaging not found");
    }
    if (pkg.accountId !== owner.accountId) {
      await forbidCrossAccount(this.accounts, pkg.accountId, owner);
    }
    // Resolve the selected hook (and stored script) from the STORED project on
    // this packaging doc — never from a client-supplied id (that would re-open
    // the trust gap on regenerate).
    const videoProjectId = pkg.videoProjectId ?? undefined;
    const validItems: PackagingItemName[] = ["title", "description", "thumbnail", "shorts"];
    if (!validItems.includes(item as PackagingItemName)) {
      throw BadRequest(`item must be one of: ${validItems.join(", ")}`);
    }
    // Script requirements are per-item: title/shorts are script-native;
    // description/thumbnail degrade to best-available context (phases 1D).
    // The body script (if sent) wins; otherwise the project's stored script
    // is resolved server-side, so no body script is needed at all.
    const resolved = await this.resolveGenerationInputs(owner, videoProjectId, script);
    if ((item === "title" || item === "shorts") && !resolved.script) {
      throw BadRequest("script is required");
    }
    if ((item === "description" || item === "thumbnail") && !title) {
      throw BadRequest("title is required for description and thumbnail regeneration");
    }

    return this.steps.run({ actor: owner, kind: item as PackagingItemName, projectId: videoProjectId, mode: "regenerate" }, async (charge) => {
      // Save previous item status for rollback on failure
      const currentStatuses: Partial<IPackagingItemStatuses> = pkg.itemStatuses ?? {};
      const statusKey = item as PackagingItemName;

      let result: unknown;
      let fieldKey: string;

      // No rollback here, deliberately. This used to try/catch and write
      // `itemStatuses.<item>` back to the value it had just READ, because
      // regenerate calls the pure `run*` generators, and the only writer of
      // item statuses (`persistGeneratedItem` → `upsertGeneratedItem`) is on
      // the `generate*` path. Nothing between the read above and a thrown
      // generation error can change the status, so the "rollback" was a write
      // of the current value — a bare catch-and-rethrow, letting it propagate
      // unchanged is the same behavior with less code.
      // If a status is ever set before generation starts, restore it here.
      if (item === "title") {
        result = await this.runTitle(owner, resolved.script, videoProjectId);
        fieldKey = "titles";
      } else if (item === "description") {
        result = await this.runDescription(owner, resolved.script || undefined, title!, videoProjectId);
        fieldKey = "description";
      } else if (item === "thumbnail") {
        result = await this.runThumbnail(owner, resolved.script || undefined, title!, videoProjectId);
        fieldKey = "thumbnail";
      } else {
        // Same default the generate-shorts path uses client-side; regenerate
        // must not 400 when the client omits it (it always did).
        result = await this.runShorts(owner, resolved.script, duration ?? 60, videoProjectId);
        fieldKey = "shorts";
      }

      // Normalize once: store AND return the canonical shape, so the regenerate
      // response matches what a subsequent GET / export returns (no wrapper-vs-stored split).
      const canonical = this.normalizeField(fieldKey, result);
      // Same guard on the regenerate path, where the erasure is the whole risk:
      // this write REPLACES content the user already had.
      if (this.isEmptyField(fieldKey, canonical)) {
        throw ServiceUnavailable(`Couldn't regenerate the ${item}. Please try again.`);
      }
      const updateData: Record<string, unknown> = {
        [fieldKey]: canonical,
        [`itemStatuses.${statusKey}`]: "completed",
      };

      // Fresh briefs replace the old ones, so a stored selection now points at a
      // brief that no longer exists — reset it (and the hint below follows suit).
      if (item === "thumbnail") {
        updateData.selectedThumbnailIndex = 0;
      }

      // Same for titles, but with a bigger blast radius: the selected title is also
      // the PROJECT'S NAME. Leaving the old index behind meant the header and
      // dashboard kept a title that no longer appears in the list, and "Continue"
      // later renamed the project to whatever happened to land at that index.
      if (item === "title") {
        updateData.selectedTitleIndex = null;
      }

      // Check if clearing stale flag is needed.
      //
      // THREE items, not four — `title` is deliberately excluded. Since P6A, Title
      // is its own pipeline step: it starts on generate-title and completes on
      // select-title, and the Packaging step covers description + thumbnail +
      // shorts. The completion check below (`packagingComplete`) already uses those
      // three; this condition used all four, and the mismatch deadlocked the stale
      // banner.
      //
      // How it deadlocked: `markStale` flips EVERY completed item to stale,
      // title included. The client then regenerates only the packaging-owned items
      // (`ProjectPackaging/index.tsx:223` filters `item !== "title"`, correctly —
      // regenerating title there would discard the user's selected title and
      // collide with the Title screen's own flow). So `itemStatuses.title` stayed
      // "stale" forever, `anyStillStale` stayed true, `isStale` was never cleared
      // and `refreshPackagingStep` never ran. The user regenerated all three items,
      // watched them succeed, and the amber "needs update" banner never went away.
      // Only "Keep as-is" could dismiss it.
      //
      // Title staleness is not lost — it lives on `pipeline.title` and is cleared
      // by select-title / reopenTitleStep, which is the step that owns it.
      const PACKAGING_OWNED_ITEMS: PackagingItemName[] = ["description", "thumbnail", "shorts"];
      const anyStillStale = PACKAGING_OWNED_ITEMS.some(
        (k) => k !== statusKey && currentStatuses[k] === "stale"
      );

      if (!anyStillStale) {
        updateData.isStale = false;
        updateData.staleReason = null;
        updateData.staleSince = null;
      }

      await this.repo.update(packagingId, updateData, ...(charge ? [charge] as const : []));

      // Packaging is fresh again — clear the project's stale packaging step so the
      // dashboard "needs update" badge actually clears. Best-effort: a sync failure
      // must not fail the already-saved regeneration.
      if (!anyStillStale && videoProjectId) {
        try {
          await this.videoProjectService.refreshPackagingStep(videoProjectId, owner, ...(charge ? [charge] as const : []));
        } catch (syncError) {
          console.error(JSON.stringify({ event: "stale_cascade_clear_failed", projectId: videoProjectId, packagingId, userId, message: (syncError as Error)?.message }));
        }
      }

      if (videoProjectId) {
        try {
          if (item === "title") {
            // The pick is gone with the old variations — reopen the step so the
            // creator is asked to choose again rather than shown a green step over
            // a project name that no longer matches any title on screen.
            await this.videoProjectService.reopenTitleStep(videoProjectId, owner, ...(charge ? [charge] as const : []));
          } else {
            // Regenerating the item that was MISSING is how a creator recovers from a
            // partial generation failure. `refreshPackagingStep` only ever un-stales,
            // so without this the step stayed in_progress forever: every item present,
            // the project stuck on "In progress", and the celebration never firing.
            const settled = { ...currentStatuses, [statusKey]: "completed" };
            if (
              settled.description === "completed" &&
              settled.thumbnail === "completed" &&
              settled.shorts === "completed"
            ) {
              await this.videoProjectService.startStep(videoProjectId, "packaging", owner, ...(charge ? [charge] as const : []));
              await this.videoProjectService.completeStep(videoProjectId, "packaging", owner, ...(charge ? [charge] as const : []));
            }
          }
        } catch (stepError) {
          console.error(JSON.stringify({ event: "pipeline_transition_failed", step: item === "title" ? "title" : "packaging", projectId: videoProjectId, packagingId, userId, message: (stepError as Error)?.message }));
        }
      }

      // The thumbnail content changed -> refresh the project's dashboard thumbnailHint
      // (best-effort; otherwise it stays the brief captured at save time).
      if (item === "thumbnail" && videoProjectId) {
        try {
          const briefs = updateData.thumbnail as string[] | undefined;
          await this.videoProjectService.setThumbnailHint(videoProjectId, briefs?.[0] ?? null, owner, ...(charge ? [charge] as const : []));
        } catch (hintError) {
          console.error(JSON.stringify({ event: "thumbnail_hint_refresh_failed", projectId: videoProjectId, packagingId, userId, message: (hintError as Error)?.message }));
        }
      }

      return { id: packagingId, item, data: canonical };
    });
  };

  exportPackaging = async (owner: RecordOwner, packagingId: string) => {
    const pkg = await this.repo.get(packagingId);
    if (!pkg) {
      throw NotFound("Packaging not found");
    }
    if (pkg.accountId !== owner.accountId) {
      await forbidCrossAccount(this.accounts, pkg.accountId, owner);
    }

    const today = new Date().toLocaleDateString("en-US", {
      year: "numeric",
      month: "long",
      day: "numeric",
    });

    const formatValue = (val: unknown): string => {
      if (val === undefined || val === null) return "N/A";
      if (typeof val === "string") return val;
      return JSON.stringify(val, null, 2);
    };

    // The export is what the creator pastes into YouTube, so it has to say which
    // variation they chose — an unmarked list of three makes them pick twice.
    const mark = (i: number, selected: number | null | undefined) =>
      i === selected ? "  ← selected" : "";

    const titles = pkg.titles;
    const titlesText = Array.isArray(titles)
      ? titles
          .map((t: unknown, i: number) => `${i + 1}. ${typeof t === "string" ? t : ((t as { title?: string })?.title ?? JSON.stringify(t))}${mark(i, pkg.selectedTitleIndex)}`)
          .join("\n")
      : formatValue(titles);

    const thumbnail = pkg.thumbnail;
    const thumbnailText = Array.isArray(thumbnail)
      ? thumbnail.map((d: unknown, i: number) => `${i + 1}. ${typeof d === "string" ? d : JSON.stringify(d)}${mark(i, pkg.selectedThumbnailIndex ?? 0)}`).join("\n")
      : formatValue(thumbnail);

    const shorts = pkg.shorts ?? undefined;
    const shortsText = shorts && Array.isArray(shorts.segments)
      ? [
          ...shorts.segments.map((s) => `[${s.startTime ?? ""}–${s.endTime ?? ""}] (${s.type ?? ""}) ${s.content ?? ""}`),
          shorts.totalDuration ? `Total: ${shorts.totalDuration}` : "",
        ].filter(Boolean).join("\n")
      : formatValue(pkg.shorts);

    const lines = [
      `Video Package — ${today}`,
      "══════════════════════════════════",
      "",
      "TITLES",
      "──────",
      titlesText,
      "",
      "DESCRIPTION",
      "───────────",
      formatValue(pkg.description),
      "",
      "THUMBNAIL BRIEF",
      "───────────────",
      thumbnailText,
      "",
      "SHORTS SCRIPT",
      "─────────────",
      shortsText,
    ];

    return { text: lines.join("\n") };
  };
}

export default PackagingService;
