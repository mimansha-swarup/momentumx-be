/**
 * Assembled generation context (GA §3 / phases 1A).
 * channelContext: who the creator is — always available (from the user doc,
 * or overrides for not-yet-persisted onboarding context).
 * sessionContext: what exists so far in the video project — every field
 * degrades to null when the upstream step hasn't happened yet.
 */
export interface IChannelContext {
  niche: string | null;
  targetAudience: string | null;
  brandName: string | null;
  website: string | null;
  websiteContent: string | null;
  channelDescription: string | null;
  topTitles: string[];
  competitorUrls: string[];
  competitorTitles: string[];
}

export interface ISessionContext {
  videoProjectId: string | null;
  topicId: string | null;
  workingTitle: string | null;
  script: string | null;
  selectedHook: string | null;
  packagingId: string | null;
}

export interface IAssembledContext {
  channelContext: IChannelContext;
  sessionContext: ISessionContext;
}

export type IChannelContextOverrides = Partial<IChannelContext>;

export interface IAssembleOptions {
  videoProjectId?: string;
  overrides?: IChannelContextOverrides;
}
