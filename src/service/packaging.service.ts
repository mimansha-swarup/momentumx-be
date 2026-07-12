import {
  PACKAGING_SYSTEM_PROMPT,
  GENERATE_TITLE_PROMPT,
  GENERATE_DESCRIPTION_PROMPT,
  GENERATE_THUMBNAIL_PROMPT,
  GENERATE_SHORTS_PROMPT,
} from "../constants/prompt.js";
import { GENERATION_CONFIG_PACKAGING, GENERATION_CONFIG_TITLE_VARIATIONS } from "../constants/firebase.js";
import PackagingRepository from "../repository/packaging.repository.js";
import VideoProjectService from "./video-project.service.js";
import ContextService from "./context.service.js";
import ResearchContextService from "./research-context.service.js";
import { generateStreamingContent } from "../utlils/ai.js";
import { firebase } from "../config/firebase.js";
import { BadRequest, Forbidden, NotFound } from "../utlils/errors.js";
import { IPackagingItemStatuses } from "../types/routes/video-project.js";
import { PackagingItemName } from "../types/routes/packaging.js";
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
    private researchContext?: ResearchContextService
  ) {
    this.repo = repo;
  }

  // Best-available context (phases 1D): channel context always, script/hook
  // resolved server-side from the project when not supplied by the client.
  // An explicit body script wins over the stored one (supports edited-but-
  // unsaved scripts and keeps existing calls behaving identically).
  private resolveGenerationInputs = async (
    userId: string,
    videoProjectId?: string,
    explicitScript?: string
  ): Promise<IGenerationInputs> => {
    const ctx = await this.contextService.assemble(
      userId,
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

  private generateContent = async (
    userPrompt: string,
    config = GENERATION_CONFIG_PACKAGING
  ) => {
    const result = await generateStreamingContent(
      PACKAGING_SYSTEM_PROMPT,
      userPrompt,
      config
    );

    let accumulatedRes = "";
    for await (const chunk of result.stream) {
      const part = chunk.text();
      if (part) {
        accumulatedRes += part;
      }
    }

    return JSON.parse(accumulatedRes);
  };

  // The post-script Title step (phase 2C): script + hook + channel context +
  // live competitive title research → 3 scored variations. Research query =
  // the project's working title when available (specific beats broad), else
  // the script's opening. Research failure degrades to context-only titles.
  generateTitle = async (userId: string, script?: string, videoProjectId?: string) => {
    const inputs = await this.resolveGenerationInputs(userId, videoProjectId, script);
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
    return this.generateContent(userPrompt, GENERATION_CONFIG_TITLE_VARIATIONS);
  };

  generateDescription = async (
    userId: string,
    script: string | undefined,
    title: string,
    videoProjectId?: string
  ) => {
    const inputs = await this.resolveGenerationInputs(userId, videoProjectId, script);
    const userPrompt = fillTemplate(GENERATE_DESCRIPTION_PROMPT, {
      "{title}": title,
      "{creatorContext}": buildCreatorContextBlock(inputs.channel),
      "{scriptSection}": buildScriptSection(inputs.script),
      "{hookSection}": buildHookSection(inputs.hook),
    });
    return this.generateContent(userPrompt);
  };

  generateThumbnail = async (
    userId: string,
    script: string | undefined,
    title: string,
    videoProjectId?: string
  ) => {
    const inputs = await this.resolveGenerationInputs(userId, videoProjectId, script);
    const format = resolveVideoFormat(inputs.channel?.format);
    const userPrompt = fillTemplate(GENERATE_THUMBNAIL_PROMPT, {
      "{title}": title,
      "{formatDirective}": THUMBNAIL_FORMAT_DIRECTIVE[format],
      "{creatorContext}": buildCreatorContextBlock(inputs.channel),
      "{scriptSection}": buildScriptSection(inputs.script),
      "{hookSection}": buildHookSection(inputs.hook),
    });
    return this.generateContent(userPrompt);
  };

  generateShorts = async (userId: string, script: string | undefined, duration: number, videoProjectId?: string) => {
    // Script is pipeline-native but resolved server-side: an explicit body
    // script wins, else it's pulled from the project (best-available context).
    const inputs = await this.resolveGenerationInputs(userId, videoProjectId, script);
    if (!inputs.script) {
      throw BadRequest("Provide a script or a videoProjectId with a generated script");
    }
    const userPrompt = fillTemplate(GENERATE_SHORTS_PROMPT, {
      "{creatorContext}": buildCreatorContextBlock(inputs.channel),
      "{script}": inputs.script,
      "{duration}": duration.toString(),
    });
    return this.generateContent(userPrompt);
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

  savePackaging = async (userId: string, data: Record<string, unknown>, videoProjectId?: string) => {
    // Coerce any present content field to its canonical stored shape so the
    // persisted doc matches what regenerateItem and the readers expect.
    const normalized: Record<string, unknown> = { ...data };
    for (const field of PackagingService.ITEM_FIELDS) {
      if (field in data && data[field] != null) {
        normalized[field] = this.normalizeField(field, data[field]);
      }
    }

    const itemStatuses = this.buildItemStatuses(normalized);

    // Door model (§0 / 6A.3): packaging is NEVER a standalone doc. Given a
    // project, use it (ownership-checked); with none, lazily spin up a shallow
    // one (idea + project from the packaged title) so the work is captured into
    // the pipeline. Either branch leaves us with a project for the save below.
    let projectId = videoProjectId;
    if (projectId) {
      await this.videoProjectService.getById(projectId, userId);
    } else {
      const project = await this.videoProjectService.createFromTitle(
        userId,
        this.deriveWorkingTitle(normalized)
      );
      projectId = project.id;
    }

    const packagingData = {
      ...normalized,
      createdBy: userId,
      itemStatuses,
      videoProjectId: projectId,
    };

    // Stale flags are set fresh ONLY when the document is first created — a
    // brand-new package is never stale. On update (re-save) we must NOT touch
    // them: a plain re-save would otherwise silently un-stale a package that
    // an upstream regenerate had marked stale. Genuine un-staling happens via
    // regenerateItem → refreshPackagingStep.
    const freshStaleFlags = { isStale: false, staleReason: null, staleSince: null };

    // Upsert: reuse the existing package for this project, else create one.
    const existing = await this.repo.findByVideoProject(projectId);
    let result: Record<string, unknown>;
    if (existing) {
      result = await this.repo.update(existing.id as string, {
        ...packagingData,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      });
    } else {
      result = await this.repo.save({
        ...packagingData,
        ...freshStaleFlags,
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      });
    }

    try {
      await this.videoProjectService.linkResource(projectId, "packaging", result.id as string, userId);
      // A door-created (or never-started) project has packaging still not_started,
      // which completeStep rejects — start it first (startStep no-ops if already
      // in_progress/completed), so both the door and pipeline paths complete cleanly.
      await this.videoProjectService.startStep(projectId, "packaging", userId);
      await this.videoProjectService.completeStep(projectId, "packaging", userId);
    } catch (pipelineError) {
      console.error(JSON.stringify({ event: "pipeline_transition_failed", step: "packaging", projectId, packagingId: result.id, userId, message: (pipelineError as Error)?.message }));
    }
    return result;
  };

  getPackaging = async (packagingId: string, userId: string) => {
    const result = await this.repo.get(packagingId);
    if (!result) return null;
    if (result.createdBy !== userId) throw Forbidden();
    return result;
  };

  getPackagingByUser = async (userId: string) => {
    return this.repo.getByUserId(userId);
  };

  // Title continuity (§7.3): the user finalizes one of the generated Title
  // variations. Persist the choice and promote it to the project's display title
  // (the idea working-title was only ever a placeholder).
  selectTitle = async (userId: string, packagingId: string, index: number) => {
    const pkg = await this.repo.get(packagingId);
    if (!pkg) {
      throw NotFound("Packaging not found");
    }
    if (pkg.createdBy !== userId) {
      throw Forbidden();
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
      await this.videoProjectService.update(pkg.videoProjectId, userId, { title: titleText });
    }

    return { id: packagingId, selectedTitleIndex: index, title: titleText };
  };

  regenerateItem = async (
    userId: string,
    packagingId: string,
    item: string,
    script?: string,
    title?: string,
    duration?: number
  ) => {
    const pkg = await this.repo.get(packagingId);
    if (!pkg) {
      throw NotFound("Packaging not found");
    }
    if (pkg.createdBy !== userId) {
      throw Forbidden();
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
    const resolved = await this.resolveGenerationInputs(userId, videoProjectId, script);
    if ((item === "title" || item === "shorts") && !resolved.script) {
      throw BadRequest("script is required");
    }
    if ((item === "description" || item === "thumbnail") && !title) {
      throw BadRequest("title is required for description and thumbnail regeneration");
    }
    if (item === "shorts" && !duration) {
      throw BadRequest("duration is required for shorts regeneration");
    }

    // Save previous item status for rollback on failure
    const currentStatuses: Partial<IPackagingItemStatuses> = pkg.itemStatuses ?? {};
    const statusKey = item as PackagingItemName;
    const previousStatus = currentStatuses[statusKey] ?? "not_started";

    let result: unknown;
    let fieldKey: string;

    try {
      if (item === "title") {
        result = await this.generateTitle(userId, resolved.script, videoProjectId);
        fieldKey = "titles";
      } else if (item === "description") {
        result = await this.generateDescription(userId, resolved.script || undefined, title!, videoProjectId);
        fieldKey = "description";
      } else if (item === "thumbnail") {
        result = await this.generateThumbnail(userId, resolved.script || undefined, title!, videoProjectId);
        fieldKey = "thumbnail";
      } else {
        result = await this.generateShorts(userId, resolved.script, duration!, videoProjectId);
        fieldKey = "shorts";
      }
    } catch (genError) {
      // Rollback status on generation failure
      await this.repo.update(packagingId, {
        [`itemStatuses.${statusKey}`]: previousStatus,
      });
      throw genError;
    }

    // Normalize once: store AND return the canonical shape, so the regenerate
    // response matches what a subsequent GET / export returns (no wrapper-vs-stored split).
    const canonical = this.normalizeField(fieldKey, result);
    const updateData: Record<string, unknown> = {
      [fieldKey]: canonical,
      [`itemStatuses.${statusKey}`]: "completed",
    };

    // Check if clearing stale flag is needed
    const allItems: PackagingItemName[] = ["title", "description", "thumbnail", "shorts"];
    const anyStillStale = allItems.some(
      (k) => k !== statusKey && currentStatuses[k] === "stale"
    );

    if (!anyStillStale) {
      updateData.isStale = false;
      updateData.staleReason = null;
      updateData.staleSince = null;
    }

    await this.repo.update(packagingId, updateData);

    // Packaging is fresh again — clear the project's stale packaging step so the
    // dashboard "needs update" badge actually clears. Best-effort: a sync failure
    // must not fail the already-saved regeneration.
    if (!anyStillStale && videoProjectId) {
      try {
        await this.videoProjectService.refreshPackagingStep(videoProjectId, userId);
      } catch (syncError) {
        console.error(JSON.stringify({ event: "stale_cascade_clear_failed", projectId: videoProjectId, packagingId, userId, message: (syncError as Error)?.message }));
      }
    }

    // The thumbnail content changed -> refresh the project's dashboard thumbnailHint
    // (best-effort; otherwise it stays the brief captured at save time).
    if (item === "thumbnail" && videoProjectId) {
      try {
        const briefs = updateData.thumbnail as string[] | undefined;
        await this.videoProjectService.setThumbnailHint(videoProjectId, briefs?.[0] ?? null, userId);
      } catch (hintError) {
        console.error(JSON.stringify({ event: "thumbnail_hint_refresh_failed", projectId: videoProjectId, packagingId, userId, message: (hintError as Error)?.message }));
      }
    }

    return { id: packagingId, item, data: canonical };
  };

  exportPackaging = async (userId: string, packagingId: string) => {
    const pkg = await this.repo.get(packagingId);
    if (!pkg) {
      throw NotFound("Packaging not found");
    }
    if (pkg.createdBy !== userId) {
      throw Forbidden();
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

    const titles = pkg.titles;
    const titlesText = Array.isArray(titles)
      ? titles
          .map((t: unknown, i: number) => `${i + 1}. ${typeof t === "string" ? t : ((t as { title?: string })?.title ?? JSON.stringify(t))}`)
          .join("\n")
      : formatValue(titles);

    const thumbnail = pkg.thumbnail;
    const thumbnailText = Array.isArray(thumbnail)
      ? thumbnail.map((d: unknown, i: number) => `${i + 1}. ${typeof d === "string" ? d : JSON.stringify(d)}`).join("\n")
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
