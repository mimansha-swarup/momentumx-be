import AccountRepository from "../repository/account.repository.js";
import ContentRepository from "../repository/content.repository.js";
import HooksRepository from "../repository/hooks.repository.js";
import VideoProjectService from "./video-project.service.js";
import { RecordOwner } from "../utlils/content.js";
import { NotFound } from "../utlils/errors.js";
import { forbidCrossAccount } from "./account.service.js";
import { resolveVideoFormat } from "../utlils/prompt-blocks.js";
import {
  IAssembledContext,
  IAssembleOptions,
  IChannelContext,
  IChannelContextOverrides,
  ISessionContext,
} from "../types/routes/context.js";
// The STORED channel shape, distinct from the assembled `IChannelContext` above:
// one is what the account document holds, the other is what a prompt is built
// from. They overlap but are not the same type, and conflating them is how a
// field that exists in storage silently stops reaching the prompt.
import { IChannelContext as IStoredChannelContext } from "../types/routes/account.js";

interface ICompetitorRecord {
  url?: string;
  id?: string;
  titles?: string[];
}

const EMPTY_SESSION: ISessionContext = {
  videoProjectId: null,
  ideaId: null,
  workingTitle: null,
  script: null,
  selectedHook: null,
  packagingId: null,
};

/**
 * Best-available context assembler (GA §3 / phases 1A).
 *
 * Contract:
 * - channelContext resolves from the channel context, enriched/replaced by `overrides`
 *   for not-yet-persisted onboarding context. Missing channel context with no overrides
 *   is the only NotFound this service throws itself.
 * - sessionContext degrades: absent upstream content (no script yet, no hook
 *   selected, missing idea doc) yields null fields, never an error.
 * - Invalid targets still fail loudly: a videoProjectId that doesn't exist or
 *   isn't owned by the caller propagates NotFound/Forbidden from
 *   VideoProjectService.getById, and so does a LINKED resource (idea, script,
 *   hook batch) belonging to another channel. Infrastructure errors also
 *   propagate — a degraded-context generation on a Firestore outage would be a
 *   silent quality failure.
 */
class ContextService {
  constructor(
    private accounts: AccountRepository,
    private contentRepo: ContentRepository,
    private hooksRepo: HooksRepository,
    private videoProjectService: VideoProjectService
  ) {}

  assemble = async (
    owner: RecordOwner,
    options: IAssembleOptions = {}
  ): Promise<IAssembledContext> => {
    const [channelContext, sessionContext] = await Promise.all([
      this.buildChannelContext(owner.accountId, options.overrides),
      this.buildSessionContext(owner, options.videoProjectId),
    ]);
    return { channelContext, sessionContext };
  };

  /**
   * Phase 06b. Reads the ACTIVE CHANNEL, not the user.
   *
   * This one method feeds hooks, title and packaging, so it is where the failure
   * this phase exists to prevent was widest: with the channel read from
   * `users/{uid}`, switching to the finance channel and generating produced
   * prompts built from the cooking channel's niche, competitors and website text.
   * The documents saved were tagged correctly — Phases 03–06 saw to that — and
   * the CONTENT was wrong. No error, no failing test; it reads as "the AI got
   * worse", which nobody traces to a deploy.
   */
  private buildChannelContext = async (
    accountId: string,
    overrides?: IChannelContextOverrides
  ): Promise<IChannelContext> => {
    const stored = await this.accounts.getContext(accountId);
    if (!stored && !overrides) {
      throw NotFound("Channel not found");
    }

    const record = (stored ?? {}) as Partial<IStoredChannelContext>;
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
      channelDescription: record.channelDescription ?? null,
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
    owner: RecordOwner,
    videoProjectId?: string
  ): Promise<ISessionContext> => {
    if (!videoProjectId) {
      return { ...EMPTY_SESSION };
    }

    // Throws NotFound/Forbidden for a bad or foreign project id — an invalid
    // target is a caller error, not "absent upstream content".
    const project = await this.videoProjectService.getById(videoProjectId, owner);

    // `owner` is threaded into all three resolvers, not just the project lookup.
    // Phase 06 claimed these were already ownership-closed; they were not — each
    // fetched by bare id and returned whatever came back. See the resolvers.
    const [workingTitle, script, selectedHook] = await Promise.all([
      this.resolveWorkingTitle(owner, project.ideaId, project.title),
      this.resolveScript(owner, project.scriptId),
      this.resolveSelectedHook(owner, project.hooksId, project.selectedHookIndex),
    ]);

    return {
      videoProjectId: project.id,
      ideaId: project.ideaId ?? null,
      workingTitle,
      script,
      selectedHook,
      packagingId: project.packagingId ?? null,
    };
  };

  /**
   * A linked resource must belong to the channel the caller is acting in.
   *
   * The three resolvers below fetch by a bare id taken off the project document.
   * That id is server-trusted, so nothing here is reachable from a request body —
   * which is exactly why Phase 06 recorded these as "already closed" and moved
   * on. They were not closed: an idea, script or hook batch belonging to another
   * channel would have been read and pasted straight into the prompt, and the
   * result is the failure Phase 06b describes — documents tagged correctly, the
   * CONTENT wrong, no error and no failing test.
   *
   * `linkResource` checks the resource's account before writing these pointers,
   * so a cross-channel link should be unreachable. "Should be unreachable" is the
   * reason to check it, not the reason to skip it — this is the last read before
   * the model, and it is the only place that can still catch a bad pointer.
   *
   * Throws rather than degrading to null. This file's contract already draws that
   * line: absent upstream content yields null, an INVALID target fails loudly.
   * Returning null would make a cross-tenant pointer indistinguishable from "no
   * script yet" and generate quietly worse output from it.
   */
  private assertSameChannel = async (
    owner: RecordOwner,
    resource: { accountId?: string } | null | undefined
  ): Promise<void> => {
    if (resource && resource.accountId !== owner.accountId) {
      await forbidCrossAccount(this.accounts, resource.accountId, owner);
    }
  };

  private resolveWorkingTitle = async (
    owner: RecordOwner,
    ideaId: string | null,
    projectTitle: string | null
  ): Promise<string | null> => {
    if (!ideaId) {
      return projectTitle ?? null;
    }
    const idea = await this.contentRepo.getIdea(ideaId);
    await this.assertSameChannel(owner, idea);
    return idea?.title ?? projectTitle ?? null;
  };

  private resolveScript = async (
    owner: RecordOwner,
    scriptId: string | null
  ): Promise<string | null> => {
    if (!scriptId) {
      return null;
    }
    const script = await this.contentRepo.getScriptById(scriptId);
    await this.assertSameChannel(owner, script);
    return script?.script ?? null;
  };

  private resolveSelectedHook = async (
    owner: RecordOwner,
    hooksId: string | null,
    selectedHookIndex: number | null
  ): Promise<string | null> => {
    if (!hooksId || selectedHookIndex == null) {
      return null;
    }
    const hooksBatch = await this.hooksRepo.findById(hooksId);
    await this.assertSameChannel(owner, hooksBatch);
    return hooksBatch?.hooks?.[selectedHookIndex] ?? null;
  };
}

export default ContextService;
