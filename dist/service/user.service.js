import { formatUserData, resolveChannel } from "../utlils/content.js";
import { collectJson, generateStreamingContent } from "../utlils/ai.js";
import { fillTemplate } from "../utlils/prompt-blocks.js";
import { ONBOARDING_PREFILL_SYSTEM_PROMPT, ONBOARDING_PREFILL_PROMPT, } from "../constants/prompt.js";
import { GENERATION_CONFIG_PREFILL } from "../constants/firebase.js";
import { computeProfileCompleteness } from "../utlils/profile.js";
import { NotFound } from "../utlils/errors.js";
import { adoptChannelIdentity } from "./account.service.js";
class UserService {
    constructor(repo, accounts, steps, extractService) {
        this.accounts = accounts;
        this.steps = steps;
        this.createOnboardingData = async (owner, data) => {
            // Value-first: persist the user-provided minimum IMMEDIATELY so the onboarding
            // gate clears without blocking on YouTube/website enrichment (a multi-second
            // network call). Enrichment — channel titles/description, website content,
            // competitor resolution — runs as a SEPARATE request via refresh-context,
            // which the FE fires in the background right after onboarding. (Serverless
            // can't reliably run post-response work, so it's a separate request, not a
            // deferred inline job.) `stats` is seeded at user creation by the auth trigger
            // and maintained via FieldValue.increment, so onboarding never writes it.
            // Phase 06b: the CHANNEL owns these fields, not the user. Writing them to
            // `users/{uid}` instead is what made onboarding a second channel overwrite the
            // first one's niche — one record, two channels' answers — and it is why a
            // channel created by POST /v1/accounts could never report itself onboarded.
            await this.accounts.writeContext(owner.accountId, data, owner.userId);
            // The channel is named here or nowhere: `deriveDisplayName` otherwise runs
            // only on the user's first request, before any of this exists.
            await adoptChannelIdentity(this.accounts, owner.accountId, data, owner.userId);
            return data;
        };
        // Onboarding prefill (3.2): resolve a channel URL and infer onboarding fields
        // from its description + top titles, so the user confirms rather than types.
        // Nothing is persisted — these are suggestions. Channel resolution is
        // best-effort (never throws); with no signal we return blank suggestions
        // instead of asking the model to hallucinate from nothing.
        this.prefillFromChannel = async (channelUrl, owner) => {
            /**
             * The WHOLE operation runs inside one `steps.run`, not just the model call.
             *
             * `steps.run` was previously opened inside `inferOnboardingFields`, which is only
             * reached when the channel yielded a signal. Two consequences: the YouTube
             * resolution and website scrape — the expensive, quota-metered part — happened
             * entirely OUTSIDE the lock meant to protect them, so concurrent prefills on
             * different URLs each burned quota; and a channel that resolved to nothing never
             * entered `steps.run` at all, so it took no lock and ran no membership check.
             *
             * Prefill is free (cost 0), so this reserves no credits — it is the duplicate-work
             * lock and the membership/role check that matter here.
             */
            return this.steps.run({ actor: owner, kind: "prefill" }, async () => {
                const channel = await resolveChannel(this.extractService, channelUrl);
                const description = channel?.description ?? "";
                const titles = channel?.titles ?? [];
                const suggestions = description.trim() || titles.length
                    ? await this.inferOnboardingFields(description, titles)
                    : { niche: "", targetAudience: "", brandName: "" };
                return {
                    suggestions,
                    channel: { channelDescription: description, topTitles: titles },
                };
            });
        };
        // No `owner` and no `steps.run` of its own: the caller holds the lock. Opening a
        // second reservation under the same lock key would refuse itself with 409.
        this.inferOnboardingFields = async (channelDescription, topTitles) => {
            const userPrompt = fillTemplate(ONBOARDING_PREFILL_PROMPT, {
                "{channelDescription}": channelDescription,
                "{topTitles}": topTitles.join("\n"),
            });
            const result = await generateStreamingContent(ONBOARDING_PREFILL_SYSTEM_PROMPT, userPrompt, GENERATION_CONFIG_PREFILL);
            const parsed = await collectJson(result, "channel suggestions");
            return {
                niche: parsed.niche ?? "",
                targetAudience: parsed.targetAudience ?? "",
                brandName: parsed.brandName ?? "",
            };
        };
        this.getProfile = async (owner) => {
            // Identity from the user, the channel half from the ACTIVE account, merged
            // into the shape the response already had.
            //
            // Merging rather than splitting the endpoint is deliberate: five frontend
            // consumers read channel fields straight off this response (the side drawer's
            // handle, the settings form, the dashboard stats, the enrich nudge, and
            // `selectIsOnboarded` — the routing gate). Returning identity only would break
            // all five at once, and the nudge and the gate fail SILENTLY: on a record with
            // no niche, `incomplete` is permanently true and every user is routed back to
            // onboarding.
            const [record, context] = await Promise.all([
                this.repo.get(owner.userId),
                this.accounts.getContext(owner.accountId),
            ]);
            const userId = owner.userId;
            // Never expose cleanup snapshots or use another channel's legacy profile as fallback.
            const channelKeys = new Set(["legacyChannelSnapshot", "userName", "channelId", "channelDescription", "userTitle", "niche", "targetAudience", "brandName", "website", "websiteContent", "competitors", "format", "purpose", "description"]);
            const identity = Object.fromEntries(Object.entries(record ?? {}).filter(([key]) => !channelKeys.has(key)));
            return {
                ...identity,
                ...(context ?? {}),
                // Always answer with the uid. The onboarding write (`repo.add`) never
                // stores it, so profiles created that way came back without one — and the
                // client treated a uid-less response as "no profile", threw the stored
                // niche/targetAudience away, and bounced the user back into onboarding
                // forever. It's `req.userId` here, so this can never be wrong or drift.
                uid: userId,
                // Per CHANNEL now, which is more useful than per user anyway — "this
                // channel is 60% set up". Computed from the record it describes; left on
                // the user record it would report the same score for every channel, and
                // zero for every channel after the first.
                completeness: computeProfileCompleteness(context),
            };
        };
        this.updateProfile = async (owner, data) => {
            const record = await formatUserData(data, this.extractService);
            await this.accounts.writeContext(owner.accountId, record, owner.userId);
            await adoptChannelIdentity(this.accounts, owner.accountId, record, owner.userId);
            return record;
        };
        // Refresh context (3.7): re-run channel/website enrichment from the STORED
        // onboarding inputs — no form fields needed. This is also the path that
        // enriches after the fast onboarding save. Competitors may be stored as raw
        // URL strings (fresh onboarding, pre-enrichment) OR as enriched {url,...}
        // objects (already refreshed) — map both back to their URLs for re-resolution.
        this.refreshContext = async (owner) => {
            const record = await this.accounts.getContext(owner.accountId);
            if (!record)
                throw NotFound("Channel not found");
            // Only `competitors` needs reshaping; everything else round-trips as stored.
            const { userName, website, brandName, niche, targetAudience, purpose, description, format } = record;
            const input = {
                userName, website, brandName, niche, targetAudience, purpose, description, format,
                competitors: (Array.isArray(record.competitors) ? record.competitors : [])
                    .map((c) => (typeof c === "string" ? c : c?.url))
                    .filter((url) => Boolean(url)),
            };
            const refreshed = await formatUserData(input, this.extractService);
            await this.accounts.writeContext(owner.accountId, refreshed, owner.userId);
            // Enrichment resolves the channel URL, so this is where a channel onboarded
            // fast (before enrichment) finally gets its "@handle".
            await adoptChannelIdentity(this.accounts, owner.accountId, refreshed, owner.userId);
            return { ...refreshed, completeness: computeProfileCompleteness(refreshed) };
        };
        this.repo = repo;
        this.extractService = extractService;
    }
}
export default UserService;
