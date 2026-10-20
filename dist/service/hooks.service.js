import { HOOKS_SYSTEM_PROMPT, GENERATE_HOOKS_PROMPT, } from "../constants/prompt.js";
import { GENERATION_CONFIG_HOOKS } from "../constants/firebase.js";
import { collectJson, generateStreamingContent } from "../utlils/ai.js";
import { buildCreatorContextBlock, fillTemplate } from "../utlils/prompt-blocks.js";
import { BadRequest, NotFound, ServiceUnavailable } from "../utlils/errors.js";
import { forbidCrossAccount } from "./account.service.js";
// The schema requires exactly 5 non-empty strings, but a schema is a request to
// the model, not a guarantee from it — a blocked or truncated generation can still
// resolve to a shape the rest of this file indexes into. Assert before persisting
// so a bad batch never reaches Firestore, rather than surfacing later as an empty
// hooks screen. Not a repair: it refuses, it doesn't reshape.
const assertHooks = (parsed) => {
    const ok = Array.isArray(parsed?.hooks) &&
        parsed.hooks.length > 0 &&
        parsed.hooks.every((h) => typeof h === "string" && h.trim().length > 0);
    if (!ok) {
        console.error(JSON.stringify({ event: "ai_shape_invalid", label: "hooks" }));
        throw ServiceUnavailable("Couldn't generate hooks — the response was incomplete. Please try again.");
    }
};
class HooksService {
    constructor(repo, videoProjectService, contextService, 
    // REQUIRED, deliberately. An optional runner would mean a missing wire
    // silently skips the lock and (from Phase 08) the debit — failing open on
    // exactly the concern the seam exists to guarantee. A missing argument
    // should be a compile error, not a quiet downgrade.
    steps, accounts) {
        this.repo = repo;
        this.videoProjectService = videoProjectService;
        this.contextService = contextService;
        this.steps = steps;
        this.accounts = accounts;
        // Body script (if sent) wins; otherwise resolve the project's stored script
        // server-side (phases 1D). Hooks are script-native — no script anywhere is a 400.
        this.buildUserPrompt = async (owner, videoProjectId, explicitScript) => {
            const ctx = this.contextService
                ? await this.contextService.assemble(owner, videoProjectId ? { videoProjectId } : {})
                : undefined;
            const script = explicitScript?.trim() ? explicitScript : ctx?.sessionContext.script;
            if (!script)
                throw BadRequest("script is required — none found on this project");
            return fillTemplate(GENERATE_HOOKS_PROMPT, {
                "{script}": script,
                "{creatorContext}": buildCreatorContextBlock(ctx?.channelContext),
            });
        };
        this.generate = async (owner, videoProjectId, script) => {
            const { userId, accountId } = owner;
            // Idempotent replay stays OUTSIDE the seam: returning an existing batch is
            // not a generation. It must not take the lock and must not spend a credit.
            const project = await this.videoProjectService.getById(videoProjectId, owner);
            if (project.hooksId) {
                const existing = await this.repo.findById(project.hooksId);
                if (existing)
                    return existing;
            }
            const userPrompt = await this.buildUserPrompt(owner, videoProjectId, script);
            // Everything the old body hand-rolled — the script precondition, the
            // read-then-write "lock" that wasn't atomic, the swallowed startStep, and the
            // abandon-on-failure block — now lives in the seam. `REQUIRES.hooks` carries
            // the precondition; `BillingRepository.reserve` enforces it in the transaction that
            // takes the lock; settlement restores prior state on failure (and, unlike
            // the old abandon, does not clear a stale marker).
            const hooksBatch = await this.steps.run({ actor: owner, kind: "hooks", projectId: videoProjectId }, async (charge) => {
                const result = await generateStreamingContent(HOOKS_SYSTEM_PROMPT, userPrompt, GENERATION_CONFIG_HOOKS);
                const parsed = await collectJson(result, "hooks");
                assertHooks(parsed);
                const saved = await this.repo.save({
                    videoProjectId,
                    createdBy: userId,
                    accountId,
                    hooks: parsed.hooks,
                    hookFeedback: {},
                }, ...(charge ? [charge] : []));
                if (project.hooksId) {
                    // Replacing a missing batch invalidates the old selection just like
                    // regeneration. Finish the fenced cascade before linking new hooks.
                    await this.videoProjectService.clearSelectedHook(videoProjectId, owner, ...(charge ? [charge] : []));
                    await this.videoProjectService.markStale(videoProjectId, "hooks", ...(charge ? [charge] : []));
                    await this.videoProjectService.markPackagingDocumentStale(videoProjectId, "hooks_regenerated", ...(charge ? [charge] : []));
                }
                await this.videoProjectService.linkResource(videoProjectId, "hooks", saved.id, owner, ...(charge ? [charge] : []));
                return saved;
            });
            return hooksBatch;
        };
        this.select = async (owner, hooksId, hookIndex) => {
            const { userId } = owner;
            const hooksBatch = await this.repo.findById(hooksId);
            if (!hooksBatch) {
                throw NotFound("Hooks batch not found");
            }
            if (hooksBatch.accountId !== owner.accountId) {
                await forbidCrossAccount(this.accounts, hooksBatch.accountId, owner);
            }
            if (hookIndex < 0 || hookIndex >= hooksBatch.hooks.length) {
                throw BadRequest(`hookIndex out of range. Must be 0–${hooksBatch.hooks.length - 1}`);
            }
            // Resolve the project from the STORED batch — never trust a client-supplied id
            // (mirrors regenerate; closes DA5: binding a batch to a non-origin project).
            const videoProjectId = hooksBatch.videoProjectId;
            if (!videoProjectId) {
                throw BadRequest("Hooks batch is not linked to a video project");
            }
            const result = await this.videoProjectService.setSelectedHook(videoProjectId, hooksId, hookIndex, owner);
            try {
                await this.videoProjectService.completeStep(videoProjectId, "hooks", owner);
            }
            catch (stepError) {
                console.error(JSON.stringify({ event: "pipeline_transition_failed", step: "hooks", projectId: videoProjectId, userId, message: stepError?.message }));
            }
            return result;
        };
        this.regenerate = async (owner, hooksId, script) => {
            const { userId } = owner;
            const hooksBatch = await this.repo.findById(hooksId);
            if (!hooksBatch) {
                throw NotFound("Hooks batch not found");
            }
            if (hooksBatch.accountId !== owner.accountId) {
                await forbidCrossAccount(this.accounts, hooksBatch.accountId, owner);
            }
            if (!script && !hooksBatch.videoProjectId) {
                throw BadRequest("script is required");
            }
            const userPrompt = await this.buildUserPrompt(owner, hooksBatch.videoProjectId, script);
            // Regeneration uses a distinct in-flight lock and metering, but skips
            // starting-step preconditions. Pipeline status is never its lock.
            //
            // An earlier version of this wrapped regenerate identically to generate, on
            // the theory that it "gains the lock it never had". That broke the primary
            // regenerate flow: hooks stays `in_progress` from generate until the user
            // selects one, so the ordinary "try again" click 409'd for three minutes —
            // and a successful regenerate calls `clearSelectedHook`, which sets the step
            // back to `in_progress` and re-arms it for the next attempt. The precondition
            // was wrong for the same reason: after an upstream regen marks `script`
            // stale, regenerating hooks is exactly what the user needs and it would 400.
            return this.steps.run({
                actor: owner,
                kind: "hooks",
                projectId: hooksBatch.videoProjectId,
                mode: "regenerate",
            }, async (charge) => {
                const result = await generateStreamingContent(HOOKS_SYSTEM_PROMPT, userPrompt, GENERATION_CONFIG_HOOKS);
                const parsed = await collectJson(result, "hooks");
                assertHooks(parsed);
                await this.repo.update(hooksId, { hooks: parsed.hooks, hookFeedback: {} }, ...(charge ? [charge] : []));
                try {
                    await this.videoProjectService.clearSelectedHook(hooksBatch.videoProjectId, owner, ...(charge ? [charge] : []));
                    await this.videoProjectService.markStale(hooksBatch.videoProjectId, "hooks", ...(charge ? [charge] : []));
                    await this.videoProjectService.markPackagingDocumentStale(hooksBatch.videoProjectId, "hooks_regenerated", ...(charge ? [charge] : []));
                }
                catch (cascadeError) {
                    console.error(JSON.stringify({ event: "stale_cascade_failed", from: "hooks", projectId: hooksBatch.videoProjectId, userId, message: cascadeError?.message }));
                }
                return { id: hooksId, hooks: parsed.hooks, hookFeedback: {} };
            });
        };
        // Read a saved batch. Without this the hooks existed only in the browser's
        // memory: after a refresh the creator could see "Hook 3 was selected" but never
        // the hook itself, and had no way to change the pick.
        this.getById = async (owner, hooksId) => {
            const hooksBatch = await this.repo.findById(hooksId);
            if (!hooksBatch) {
                throw NotFound("Hooks batch not found");
            }
            if (hooksBatch.accountId !== owner.accountId) {
                await forbidCrossAccount(this.accounts, hooksBatch.accountId, owner);
            }
            return hooksBatch;
        };
        this.exportHooks = async (owner, hooksId) => {
            const hooksBatch = await this.repo.findById(hooksId);
            if (!hooksBatch) {
                throw NotFound("Hooks batch not found");
            }
            if (hooksBatch.accountId !== owner.accountId) {
                await forbidCrossAccount(this.accounts, hooksBatch.accountId, owner);
            }
            const today = new Date().toLocaleDateString("en-US", {
                year: "numeric",
                month: "long",
                day: "numeric",
            });
            const lines = [
                `Hooks — ${today}`,
                "──────────────────────────────────",
                ...hooksBatch.hooks.map((h, i) => `${i + 1}. ${h}`),
            ];
            return { text: lines.join("\n"), count: hooksBatch.hooks.length };
        };
    }
}
export default HooksService;
