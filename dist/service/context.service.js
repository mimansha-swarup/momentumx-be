import { NotFound } from "../utlils/errors.js";
import { resolveVideoFormat } from "../utlils/prompt-blocks.js";
const EMPTY_SESSION = {
    videoProjectId: null,
    topicId: null,
    workingTitle: null,
    script: null,
    selectedHook: null,
    packagingId: null,
};
/**
 * Best-available context assembler (GA §3 / phases 1A).
 *
 * Contract:
 * - channelContext always resolves (user doc, enriched/replaced by `overrides`
 *   for not-yet-persisted onboarding context). Missing user with no overrides
 *   is the only NotFound this service throws itself.
 * - sessionContext degrades: absent upstream content (no script yet, no hook
 *   selected, missing topic doc) yields null fields, never an error.
 * - Invalid targets still fail loudly: a videoProjectId that doesn't exist or
 *   isn't owned by the caller propagates NotFound/Forbidden from
 *   VideoProjectService.getById. Infrastructure errors also propagate — a
 *   degraded-context generation on a Firestore outage would be a silent
 *   quality failure.
 */
class ContextService {
    constructor(userRepo, contentRepo, hooksRepo, videoProjectService) {
        this.userRepo = userRepo;
        this.contentRepo = contentRepo;
        this.hooksRepo = hooksRepo;
        this.videoProjectService = videoProjectService;
        this.assemble = async (userId, options = {}) => {
            const [channelContext, sessionContext] = await Promise.all([
                this.buildChannelContext(userId, options.overrides),
                this.buildSessionContext(userId, options.videoProjectId),
            ]);
            return { channelContext, sessionContext };
        };
        this.buildChannelContext = async (userId, overrides) => {
            const userRecord = await this.userRepo.get(userId);
            if (!userRecord && !overrides) {
                throw NotFound("User not found");
            }
            const record = userRecord ?? {};
            const competitors = Array.isArray(record.competitors)
                ? record.competitors
                : [];
            const base = {
                format: resolveVideoFormat(record.format),
                niche: record.niche ?? null,
                targetAudience: record.targetAudience ?? null,
                brandName: record.brandName ?? null,
                website: record.website ?? null,
                websiteContent: record.websiteContent ?? null,
                // Prefer the dedicated field (3.5); fall back to legacy docs that stored
                // the channel description in `description` before the split.
                channelDescription: record.channelDescription ?? record.description ?? null,
                topTitles: Array.isArray(record.userTitle) ? record.userTitle : [],
                competitorUrls: competitors
                    .map((competitor) => competitor?.url)
                    .filter((url) => Boolean(url)),
                competitorTitles: competitors.flatMap((competitor) => competitor?.titles ?? []),
            };
            if (!overrides) {
                return base;
            }
            // Apply only defined override keys — an undefined override must not
            // clobber a real stored value.
            const applied = Object.fromEntries(Object.entries(overrides).filter(([, value]) => value !== undefined));
            return { ...base, ...applied };
        };
        this.buildSessionContext = async (userId, videoProjectId) => {
            if (!videoProjectId) {
                return { ...EMPTY_SESSION };
            }
            // Throws NotFound/Forbidden for a bad or foreign project id — an invalid
            // target is a caller error, not "absent upstream content".
            const project = await this.videoProjectService.getById(videoProjectId, userId);
            const [workingTitle, script, selectedHook] = await Promise.all([
                this.resolveWorkingTitle(project.topicId, project.title),
                this.resolveScript(project.scriptId),
                this.resolveSelectedHook(project.hooksId, project.selectedHookIndex),
            ]);
            return {
                videoProjectId: project.id,
                topicId: project.topicId ?? null,
                workingTitle,
                script,
                selectedHook,
                packagingId: project.packagingId ?? null,
            };
        };
        this.resolveWorkingTitle = async (topicId, projectTitle) => {
            if (!topicId) {
                return projectTitle ?? null;
            }
            const topic = await this.contentRepo.getTopic(topicId);
            return topic?.title ?? projectTitle ?? null;
        };
        this.resolveScript = async (scriptId) => {
            if (!scriptId) {
                return null;
            }
            const script = await this.contentRepo.getScriptById(scriptId);
            return script?.script ?? null;
        };
        this.resolveSelectedHook = async (hooksId, selectedHookIndex) => {
            if (!hooksId || selectedHookIndex == null) {
                return null;
            }
            const hooksBatch = await this.hooksRepo.findById(hooksId);
            return hooksBatch?.hooks?.[selectedHookIndex] ?? null;
        };
    }
}
export default ContextService;
