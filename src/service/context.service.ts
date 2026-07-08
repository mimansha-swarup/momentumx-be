import UserRepository from "../repository/user.repository.js";
import ContentRepository from "../repository/content.repository.js";
import HooksRepository from "../repository/hooks.repository.js";
import VideoProjectService from "./video-project.service.js";
import { NotFound } from "../utlils/errors.js";
import { resolveVideoFormat } from "../utlils/prompt-blocks.js";
import {
  IAssembledContext,
  IAssembleOptions,
  IChannelContext,
  IChannelContextOverrides,
  ISessionContext,
} from "../types/routes/context.js";

interface ICompetitorRecord {
  url?: string;
  id?: string;
  titles?: string[];
}

const EMPTY_SESSION: ISessionContext = {
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
  constructor(
    private userRepo: UserRepository,
    private contentRepo: ContentRepository,
    private hooksRepo: HooksRepository,
    private videoProjectService: VideoProjectService
  ) {}

  assemble = async (
    userId: string,
    options: IAssembleOptions = {}
  ): Promise<IAssembledContext> => {
    const [channelContext, sessionContext] = await Promise.all([
      this.buildChannelContext(userId, options.overrides),
      this.buildSessionContext(userId, options.videoProjectId),
    ]);
    return { channelContext, sessionContext };
  };

  private buildChannelContext = async (
    userId: string,
    overrides?: IChannelContextOverrides
  ): Promise<IChannelContext> => {
    const userRecord = await this.userRepo.get(userId);
    if (!userRecord && !overrides) {
      throw NotFound("User not found");
    }

    const record = userRecord ?? {};
    const competitors: ICompetitorRecord[] = Array.isArray(record.competitors)
      ? record.competitors
      : [];

    const base: IChannelContext = {
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
        .filter((url): url is string => Boolean(url)),
      competitorTitles: competitors.flatMap(
        (competitor) => competitor?.titles ?? []
      ),
    };

    if (!overrides) {
      return base;
    }
    // Apply only defined override keys — an undefined override must not
    // clobber a real stored value.
    const applied = Object.fromEntries(
      Object.entries(overrides).filter(([, value]) => value !== undefined)
    );
    return { ...base, ...applied };
  };

  private buildSessionContext = async (
    userId: string,
    videoProjectId?: string
  ): Promise<ISessionContext> => {
    if (!videoProjectId) {
      return { ...EMPTY_SESSION };
    }

    // Throws NotFound/Forbidden for a bad or foreign project id — an invalid
    // target is a caller error, not "absent upstream content".
    const project = await this.videoProjectService.getById(
      videoProjectId,
      userId
    );

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

  private resolveWorkingTitle = async (
    topicId: string | null,
    projectTitle: string | null
  ): Promise<string | null> => {
    if (!topicId) {
      return projectTitle ?? null;
    }
    const topic = await this.contentRepo.getTopic(topicId);
    return topic?.title ?? projectTitle ?? null;
  };

  private resolveScript = async (
    scriptId: string | null
  ): Promise<string | null> => {
    if (!scriptId) {
      return null;
    }
    const script = await this.contentRepo.getScriptById(scriptId);
    return script?.script ?? null;
  };

  private resolveSelectedHook = async (
    hooksId: string | null,
    selectedHookIndex: number | null
  ): Promise<string | null> => {
    if (!hooksId || selectedHookIndex == null) {
      return null;
    }
    const hooksBatch = await this.hooksRepo.findById(hooksId);
    return hooksBatch?.hooks?.[selectedHookIndex] ?? null;
  };
}

export default ContextService;
