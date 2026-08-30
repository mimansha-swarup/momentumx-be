import { PACKAGING_SYSTEM_PROMPT, GENERATE_TITLE_PROMPT, GENERATE_DESCRIPTION_PROMPT, GENERATE_THUMBNAIL_PROMPT, GENERATE_SHORTS_PROMPT, } from "../constants/prompt.js";
import { GENERATION_CONFIG_TITLE_VARIATIONS, GENERATION_CONFIG_SHORTS, GENERATION_CONFIG_DESCRIPTION, GENERATION_CONFIG_THUMBNAIL, } from "../constants/firebase.js";
import { collectJson, generateStreamingContent } from "../utlils/ai.js";
import { firebase } from "../config/firebase.js";
import { BadRequest, NotFound } from "../utlils/errors.js";
import { forbidCrossAccount } from "./account.service.js";
import { buildCreatorContextBlock, buildHookSection, buildScriptSection, fillTemplate, THUMBNAIL_FORMAT_DIRECTIVE, resolveVideoFormat, } from "../utlils/prompt-blocks.js";
class PackagingService {
    constructor(repo, videoProjectService, contextService, accounts, researchContext) {
        this.videoProjectService = videoProjectService;
        this.contextService = contextService;
        this.accounts = accounts;
        this.researchContext = researchContext;
        // Best-available context (phases 1D): channel context always, script/hook
        // resolved server-side from the project when not supplied by the client.
        // An explicit body script wins over the stored one (supports edited-but-
        // unsaved scripts and keeps existing calls behaving identically).
        this.resolveGenerationInputs = async (owner, videoProjectId, explicitScript) => {
            const ctx = await this.contextService.assemble(owner, videoProjectId ? { videoProjectId } : {});
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
        this.generateContent = async (userPrompt, config, 
        // Names the item in the user-facing failure message ("Couldn't generate a
        // description — …"); a generic "content" tells them nothing about what to retry.
        label) => {
            const result = await generateStreamingContent(PACKAGING_SYSTEM_PROMPT, userPrompt, config);
            return collectJson(result, label);
        };
        // The post-script Title step (phase 2C): script + hook + channel context +
        // live competitive title research → 3 scored variations. Research query =
        // the project's working title when available (specific beats broad), else
        // the script's opening. Research failure degrades to context-only titles.
        this.runTitle = async (owner, script, videoProjectId) => {
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
        this.runDescription = async (owner, script, title, videoProjectId) => {
            const inputs = await this.resolveGenerationInputs(owner, videoProjectId, script);
            const userPrompt = fillTemplate(GENERATE_DESCRIPTION_PROMPT, {
                "{title}": title,
                "{creatorContext}": buildCreatorContextBlock(inputs.channel),
                "{scriptSection}": buildScriptSection(inputs.script),
                "{hookSection}": buildHookSection(inputs.hook),
            });
            return this.generateContent(userPrompt, GENERATION_CONFIG_DESCRIPTION, "a description");
        };
        this.runThumbnail = async (owner, script, title, videoProjectId) => {
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
        this.runShorts = async (owner, script, duration, videoProjectId) => {
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
        this.generateTitle = async (owner, script, videoProjectId) => {
            const raw = await this.runTitle(owner, script, videoProjectId);
            if (!videoProjectId)
                return raw;
            const { packagingId, canonical } = await this.persistGeneratedItem(owner, videoProjectId, "title", raw);
            return { titles: canonical, packagingId };
        };
        this.generateDescription = async (owner, script, title, videoProjectId) => {
            const raw = await this.runDescription(owner, script, title, videoProjectId);
            if (!videoProjectId)
                return raw;
            const { packagingId, canonical } = await this.persistGeneratedItem(owner, videoProjectId, "description", raw);
            return { description: canonical, packagingId };
        };
        this.generateThumbnail = async (owner, script, title, videoProjectId) => {
            const raw = await this.runThumbnail(owner, script, title, videoProjectId);
            if (!videoProjectId)
                return raw;
            const { packagingId, canonical } = await this.persistGeneratedItem(owner, videoProjectId, "thumbnail", raw);
            return { descriptions: canonical, packagingId };
        };
        this.generateShorts = async (owner, script, duration, videoProjectId) => {
            const raw = await this.runShorts(owner, script, duration, videoProjectId);
            if (!videoProjectId)
                return raw;
            const { packagingId, canonical } = await this.persistGeneratedItem(owner, videoProjectId, "shorts", raw);
            return { ...canonical, packagingId };
        };
        // Persist one freshly generated item into the project's packaging doc and
        // advance the right pipeline step. Title is its own step (generating starts it,
        // SELECTING completes it — see selectTitle); description/thumbnail/shorts are
        // the packaging step, which completes once all THREE exist. The create-or-update
        // + status snapshot is a single atomic repo transaction so two generations
        // racing can't split into two docs or both skip completion. Content write is
        // critical; pipeline transitions are best-effort (logged), matching savePackaging.
        this.persistGeneratedItem = async (owner, videoProjectId, item, rawContent) => {
            const { userId } = owner;
            // Ownership check (throws if the project isn't the caller's).
            await this.videoProjectService.getById(videoProjectId, owner);
            // Storage field == item name, except title lives under "titles". Normalize
            // BEFORE the write so malformed content throws here (no orphaned doc).
            const field = item === "title" ? "titles" : item;
            const canonical = this.normalizeField(field, rawContent);
            const { packagingId, created, statuses } = await this.repo.upsertGeneratedItem(videoProjectId, owner, field, item, canonical);
            const step = item === "title" ? "title" : "packaging";
            // Pipeline sync is best-effort: the content is already saved, so a transition
            // hiccup must not fail generation.
            try {
                if (created) {
                    await this.videoProjectService.linkResource(videoProjectId, "packaging", packagingId, owner);
                }
                await this.videoProjectService.startStep(videoProjectId, step, owner);
                // Packaging completes when its three items exist; the title step completes
                // on selection, never here.
                if (step === "packaging" &&
                    statuses.description === "completed" &&
                    statuses.thumbnail === "completed" &&
                    statuses.shorts === "completed") {
                    await this.videoProjectService.completeStep(videoProjectId, "packaging", owner);
                }
            }
            catch (pipelineError) {
                console.error(JSON.stringify({ event: "pipeline_transition_failed", step, projectId: videoProjectId, packagingId, item, userId, message: pipelineError?.message }));
            }
            return { packagingId, canonical };
        };
        this.normalizeField = (field, raw) => {
            const wrapper = (raw ?? {});
            switch (field) {
                case "titles": {
                    const v = Array.isArray(raw) ? raw : wrapper.titles;
                    if (!Array.isArray(v))
                        throw BadRequest("titles must be an array");
                    return v;
                }
                case "description": {
                    const v = typeof raw === "string" ? raw : wrapper.description;
                    if (typeof v !== "string")
                        throw BadRequest("description must be a string");
                    return v;
                }
                case "thumbnail": {
                    const v = Array.isArray(raw) ? raw : wrapper.descriptions;
                    if (!Array.isArray(v))
                        throw BadRequest("thumbnail must be an array of briefs");
                    return v;
                }
                case "shorts": {
                    const v = Array.isArray(wrapper.segments) ? raw : wrapper.shorts;
                    if (!v || !Array.isArray(v.segments)) {
                        throw BadRequest("shorts must include a segments array");
                    }
                    return v;
                }
                default:
                    return raw;
            }
        };
        this.isEmptyField = (field, value) => {
            if (value == null)
                return true;
            if (field === "shorts") {
                return !Array.isArray(value.segments) ||
                    value.segments.length === 0;
            }
            if (Array.isArray(value))
                return value.length === 0;
            if (typeof value === "string")
                return value.trim() === "";
            return false;
        };
        this.buildItemStatuses = (data) => {
            const hasContent = (key) => {
                const val = data[key];
                if (val === undefined || val === null)
                    return false;
                if (Array.isArray(val))
                    return val.length > 0;
                if (typeof val === "string")
                    return val.trim().length > 0;
                return true;
            };
            return {
                title: hasContent("titles") ? "completed" : "not_started",
                description: hasContent("description") ? "completed" : "not_started",
                thumbnail: hasContent("thumbnail") ? "completed" : "not_started",
                shorts: hasContent("shorts") ? "completed" : "not_started",
            };
        };
        // A door-saved package has no project title; use its first generated title as
        // the shallow project's working title, else a neutral placeholder.
        this.deriveWorkingTitle = (data) => {
            const titles = data.titles;
            if (Array.isArray(titles) && titles.length > 0) {
                const first = titles[0];
                if (typeof first === "string" && first.trim())
                    return first.trim();
                if (first && typeof first === "object") {
                    const t = first.title;
                    if (typeof t === "string" && t.trim())
                        return t.trim();
                }
            }
            return "Untitled video";
        };
        this.savePackaging = async (owner, data, videoProjectId) => {
            const { userId } = owner;
            // Coerce any present content field to its canonical stored shape so the
            // persisted doc matches what regenerateItem and the readers expect.
            const normalized = { ...data };
            // Never persist script/hooks snapshots: nothing reads them (generation
            // resolves both from the project), and clients used to send empty ones.
            delete normalized.script;
            delete normalized.hooks;
            for (const field of PackagingService.ITEM_FIELDS) {
                if (field in data && data[field] != null) {
                    normalized[field] = this.normalizeField(field, data[field]);
                }
                // A save carries EDITS, and empty content is never an edit — it's a client
                // that hasn't hydrated yet posting its blank initial state (the Title screen
                // sends the whole snapshot, including a description it may not have loaded).
                // Writing that would wipe generated content. No UI offers "clear this field",
                // so dropping empties costs nothing.
                if (this.isEmptyField(field, normalized[field]))
                    delete normalized[field];
            }
            // Door model (§0 / 6A.3): packaging is NEVER a standalone doc. Given a
            // project, use it (ownership-checked); with none, lazily spin up a shallow
            // one (idea + project from the packaged title) so the work is captured into
            // the pipeline. Either branch leaves us with a project for the save below.
            let projectId = videoProjectId;
            if (projectId) {
                await this.videoProjectService.getById(projectId, owner);
            }
            else {
                const project = await this.videoProjectService.createFromTitle(owner, this.deriveWorkingTitle(normalized));
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
            let result;
            if (existing) {
                result = await this.repo.update(existing.id, {
                    ...packagingData,
                    updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
                });
            }
            else {
                result = await this.repo.saveWithId(projectId, {
                    ...packagingData,
                    itemStatuses: this.buildItemStatuses(normalized),
                    ...freshStaleFlags,
                    createdAt: firebase.firestore.FieldValue.serverTimestamp(),
                });
            }
            // Completion is earned by CONTENT, never by the act of saving. A save is an
            // edit, and edits arrive from the Title screen too — unconditionally completing
            // here marked packaging done (and the project finished) the moment someone
            // renamed a title variation, with no description, thumbnail or Shorts written.
            // Same rule persistGeneratedItem uses: the three packaging items must exist.
            const merged = { ...(existing ?? {}), ...normalized };
            const settled = this.buildItemStatuses(merged);
            const packagingComplete = settled.description === "completed" &&
                settled.thumbnail === "completed" &&
                settled.shorts === "completed";
            try {
                await this.videoProjectService.linkResource(projectId, "packaging", result.id, owner);
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
            }
            catch (pipelineError) {
                console.error(JSON.stringify({ event: "pipeline_transition_failed", step: "packaging", projectId, packagingId: result.id, userId, message: pipelineError?.message }));
            }
            return result;
        };
        this.getPackaging = async (packagingId, owner) => {
            const result = await this.repo.get(packagingId);
            if (!result)
                return null;
            if (result.accountId !== owner.accountId)
                await forbidCrossAccount(this.accounts, result.accountId, owner);
            return result;
        };
        this.getPackagingByAccount = async (owner) => {
            return this.repo.getByAccountId(owner.accountId);
        };
        // Title continuity (§7.3): the user finalizes one of the generated Title
        // variations. Persist the choice and promote it to the project's display title
        // (the idea working-title was only ever a placeholder).
        this.selectTitle = async (owner, packagingId, index) => {
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
                }
                catch (stepError) {
                    console.error(JSON.stringify({ event: "pipeline_transition_failed", step: "title", projectId: pkg.videoProjectId, packagingId, userId, message: stepError?.message }));
                }
            }
            return { id: packagingId, selectedTitleIndex: index, title: titleText };
        };
        this.regenerateItem = async (owner, packagingId, item, script, title, duration) => {
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
            const validItems = ["title", "description", "thumbnail", "shorts"];
            if (!validItems.includes(item)) {
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
            // Save previous item status for rollback on failure
            const currentStatuses = pkg.itemStatuses ?? {};
            const statusKey = item;
            const previousStatus = currentStatuses[statusKey] ?? "not_started";
            let result;
            let fieldKey;
            try {
                // Pure generation (run*, not the public persisting generate*): regenerate
                // does its own targeted update + stale handling below, so it must not
                // double-persist through the public wrappers.
                if (item === "title") {
                    result = await this.runTitle(owner, resolved.script, videoProjectId);
                    fieldKey = "titles";
                }
                else if (item === "description") {
                    result = await this.runDescription(owner, resolved.script || undefined, title, videoProjectId);
                    fieldKey = "description";
                }
                else if (item === "thumbnail") {
                    result = await this.runThumbnail(owner, resolved.script || undefined, title, videoProjectId);
                    fieldKey = "thumbnail";
                }
                else {
                    // Same default the generate-shorts path uses client-side; regenerate
                    // must not 400 when the client omits it (it always did).
                    result = await this.runShorts(owner, resolved.script, duration ?? 60, videoProjectId);
                    fieldKey = "shorts";
                }
            }
            catch (genError) {
                // Rollback status on generation failure
                await this.repo.update(packagingId, {
                    [`itemStatuses.${statusKey}`]: previousStatus,
                });
                throw genError;
            }
            // Normalize once: store AND return the canonical shape, so the regenerate
            // response matches what a subsequent GET / export returns (no wrapper-vs-stored split).
            const canonical = this.normalizeField(fieldKey, result);
            const updateData = {
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
            const PACKAGING_OWNED_ITEMS = ["description", "thumbnail", "shorts"];
            const anyStillStale = PACKAGING_OWNED_ITEMS.some((k) => k !== statusKey && currentStatuses[k] === "stale");
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
                    await this.videoProjectService.refreshPackagingStep(videoProjectId, owner);
                }
                catch (syncError) {
                    console.error(JSON.stringify({ event: "stale_cascade_clear_failed", projectId: videoProjectId, packagingId, userId, message: syncError?.message }));
                }
            }
            if (videoProjectId) {
                try {
                    if (item === "title") {
                        // The pick is gone with the old variations — reopen the step so the
                        // creator is asked to choose again rather than shown a green step over
                        // a project name that no longer matches any title on screen.
                        await this.videoProjectService.reopenTitleStep(videoProjectId, owner);
                    }
                    else {
                        // Regenerating the item that was MISSING is how a creator recovers from a
                        // partial generation failure. `refreshPackagingStep` only ever un-stales,
                        // so without this the step stayed in_progress forever: every item present,
                        // the project stuck on "In progress", and the celebration never firing.
                        const settled = { ...currentStatuses, [statusKey]: "completed" };
                        if (settled.description === "completed" &&
                            settled.thumbnail === "completed" &&
                            settled.shorts === "completed") {
                            await this.videoProjectService.startStep(videoProjectId, "packaging", owner);
                            await this.videoProjectService.completeStep(videoProjectId, "packaging", owner);
                        }
                    }
                }
                catch (stepError) {
                    console.error(JSON.stringify({ event: "pipeline_transition_failed", step: item === "title" ? "title" : "packaging", projectId: videoProjectId, packagingId, userId, message: stepError?.message }));
                }
            }
            // The thumbnail content changed -> refresh the project's dashboard thumbnailHint
            // (best-effort; otherwise it stays the brief captured at save time).
            if (item === "thumbnail" && videoProjectId) {
                try {
                    const briefs = updateData.thumbnail;
                    await this.videoProjectService.setThumbnailHint(videoProjectId, briefs?.[0] ?? null, owner);
                }
                catch (hintError) {
                    console.error(JSON.stringify({ event: "thumbnail_hint_refresh_failed", projectId: videoProjectId, packagingId, userId, message: hintError?.message }));
                }
            }
            return { id: packagingId, item, data: canonical };
        };
        this.exportPackaging = async (owner, packagingId) => {
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
            const formatValue = (val) => {
                if (val === undefined || val === null)
                    return "N/A";
                if (typeof val === "string")
                    return val;
                return JSON.stringify(val, null, 2);
            };
            // The export is what the creator pastes into YouTube, so it has to say which
            // variation they chose — an unmarked list of three makes them pick twice.
            const mark = (i, selected) => i === selected ? "  ← selected" : "";
            const titles = pkg.titles;
            const titlesText = Array.isArray(titles)
                ? titles
                    .map((t, i) => `${i + 1}. ${typeof t === "string" ? t : (t?.title ?? JSON.stringify(t))}${mark(i, pkg.selectedTitleIndex)}`)
                    .join("\n")
                : formatValue(titles);
            const thumbnail = pkg.thumbnail;
            const thumbnailText = Array.isArray(thumbnail)
                ? thumbnail.map((d, i) => `${i + 1}. ${typeof d === "string" ? d : JSON.stringify(d)}${mark(i, pkg.selectedThumbnailIndex ?? 0)}`).join("\n")
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
        this.repo = repo;
    }
}
// The four packaging content fields, in their canonical stored shapes:
//   titles      -> Array<{ title, characterCount }>
//   description -> string
//   thumbnail   -> string[]   (the generator's `descriptions` briefs)
//   shorts      -> { segments, totalDuration }
// Generators return these wrapped (e.g. { titles: [...] }, { descriptions: [...] }),
// and the FE save path is not solidified, so we coerce wrapper-or-bare input to the
// canonical value at every write. Malformed input throws (never persist junk/undefined).
PackagingService.ITEM_FIELDS = ["titles", "description", "thumbnail", "shorts"];
export default PackagingService;
