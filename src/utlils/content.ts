import { randomUUID } from "crypto";
import { DocumentData } from "firebase-admin/firestore";
import { kmeans } from "ml-kmeans";
import { embeddingModel } from "../config/ai.js";
import { firebase } from "../config/firebase.js";
import ContentRepository from "../repository/content.repository.js";
import ExtractService from "../service/extract.service.js";
import { IGeneratedIdea } from "../types/routes/content.js";
import { Unauthorized } from "./errors.js";

// Phase 01 item 1. Every generated record is stamped with an owner, and an empty
// owner is worse than a missing one: `""` is a real value that EVERY such record
// across EVERY user shares, so Phase 04's backfill would copy it into `accountId`
// and drop unrelated users into one bucket that reads as a tenancy leak.
//
// This asserts at SERVICE ENTRY, never inside the formatters. `regenerateAll`
// archives the previous batch before formatting, and the `Promise.allSettled`
// that follows drops rejected results silently — so a throw from a formatter
// would archive the old ideas, save zero new ones, and return 200. That trades a
// bad write for silent data loss.
export function assertOwner(userId: string | undefined): asserts userId is string {
  if (typeof userId !== "string" || userId.trim() === "") {
    throw Unauthorized("Missing authenticated user");
  }
}

// Both idea-formatting sites use `Promise.allSettled` and then keep only the
// fulfilled results. That is the right call — one failed embedding shouldn't sink
// a whole batch — but it discarded the rejections without a trace, so a partial
// generation was indistinguishable from a complete one. Log what was dropped and
// why; the caller still decides whether the survivors are enough.
export function logDroppedFormats(
  label: string,
  userId: string,
  results: PromiseSettledResult<unknown>[]
): void {
  const rejected = results.filter(
    (r): r is PromiseRejectedResult => r.status === "rejected"
  );
  if (rejected.length === 0) return;

  console.error(
    JSON.stringify({
      event: "idea_format_dropped",
      label,
      userId,
      dropped: rejected.length,
      total: results.length,
      reasons: rejected.slice(0, 3).map((r) => (r.reason as Error)?.message ?? String(r.reason)),
    })
  );
}

function extractChannelField(value: unknown, field: "id" | "description"): string {
  if (typeof value === "string") return field === "id" ? value : "";
  if (value && typeof value === "object" && field in value) {
    return ((value as Record<string, unknown>)[field] as string) ?? "";
  }
  return "";
}

/**
 * Who a generated record belongs to. ONE object, never two loose strings.
 *
 * The object is the point. Every id here is a `string`, so a positional
 * `accountId: string` parameter lets an existing call keep compiling with
 * whatever was already in that slot — a wrong tag written with no error
 * anywhere. An object is the shape a bare string cannot satisfy, which is what
 * makes the compiler enumerate the write sites instead of a grep.
 */
export interface RecordOwner {
  userId: string;
  accountId: string;
}

export const formatGeneratedTitle = async (
  title: string,
  { userId, accountId }: RecordOwner,
  batchId?: string,
) => {
  // Bounded like every other Gemini call — an unbounded embed would hang idea saves.
  const embedding = await embeddingModel.embedContent(title, { timeout: 30_000 });
  return {
    id: randomUUID(),
    title,
    // No `|| ""` fallback: callers are guarded by assertOwner at service entry,
    // and if one ever isn't, `ignoreUndefinedProperties` drops the field entirely.
    // An ABSENT owner is quarantined by Phase 04's backfill; an EMPTY-STRING one
    // is a valid value that every orphaned record shares.
    createdBy: userId,
    // Written, never read — every query still filters `createdBy` until Phase 06.
    accountId,
    createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    isScriptGenerated: false,
    embedding: embedding.embedding.values,
    batchId: batchId ?? null,
    archived: false,
    videoProjectId: null,
    userFeedback: null,
  };
};

// Idea docs (phase 2): the working title is the embedded/displayed handle;
// concept/type/evidence ride along. BYO-title docs stay title-only via
// formatGeneratedTitle above.
export const formatGeneratedIdea = async (
  idea: IGeneratedIdea,
  owner: RecordOwner,
  batchId?: string,
) => {
  const base = await formatGeneratedTitle(idea.workingTitle, owner, batchId);
  return {
    ...base,
    concept: idea.concept ?? null,
    ideaType: idea.type === "short" ? "short" : "long",
    evidence: idea.evidence?.trim() ? idea.evidence : null,
  };
};
export const formatGeneratedScript = (
  title: string,
  scriptId: string,
  ideaId: string,
  videoProjectId: string,
  script: string,
  { userId, accountId }: RecordOwner,
) => {
  return {
    id: scriptId,
    title,
    // No `|| ""` fallback: callers are guarded by assertOwner at service entry,
    // and if one ever isn't, `ignoreUndefinedProperties` drops the field entirely.
    // An ABSENT owner is quarantined by Phase 04's backfill; an EMPTY-STRING one
    // is a valid value that every orphaned record shares.
    createdBy: userId,
    accountId,
    createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    script,
    ideaId,
    videoProjectId,
  };
};

export function formatCreatorsData(
  creator: DocumentData,
  similarTitles: string[],
) {
  // If it's a single object, wrap it in an array for uniform handling
  const list = [
    { url: creator?.userName, titles: creator?.userTitle },
    // ...creator.competitors,
  ];

  let result = "";

  for (const creator of list) {
    const { url, titles = [] } = creator;

    result += `\n\n High-performing titles from the channel: ${url}\n`;
    result += titles.map((title, i) => `   ${i + 1}. ${title}`).join("\n");
    result += "\n";
  }
  result += `
    A list of proven YouTube title templates (Example that works):

    Action-Based Formats:

    "How to [Result] in 2025 [FROM $0 TO [Desired End Result]]"
    “How to Use [common software tool] - 2025 Full Tutorial”
    "How to [common searched part of your process]"
    "STOP doing [Old Way], Do This Instead to [Result]"

    Educational Formats:

    "[Niche] Has Changed in 2025... Here's Everything You Need to Know"
    "Is [Niche] a Scam?"
    The BEST Way to [Result] in 2025

    Social Proof Formats:

    ‘How [Name] Went From X to Y - Case Study Breakdown
  \n
  `;
  if (similarTitles.length) {
    result += `\n \n 
  Avoid Similar Titles that has been already generated: \n
`;

    result += similarTitles
      .map((title, i) => `   ${i + 1}. ${title}`)
      .join("\n");
  }

  return result.trim();
}

// Resolve one YouTube channel to its id, description, and top titles. Best-
// effort: any failure (invalid URL, API error) degrades to empties and never
// throws, so a single bad channel can't fail onboarding. Shared by
// formatUserData and the onboarding-prefill flow.
export async function resolveChannel(
  extractService: ExtractService,
  url: string,
): Promise<{ id: string; description: string; titles: string[] } | null> {
  try {
    const info = await extractService.retrieveChannelId(url);
    const id = extractChannelField(info, "id");
    const description = extractChannelField(info, "description");
    const titles = id ? (await extractService.getTopTenTitle(id)) ?? [] : [];
    return { id, description, titles };
  } catch {
    // null, NOT empties. Callers otherwise can't tell "this channel has no
    // description" from "YouTube refused us" — and a quota-exhausted refresh
    // then wrote those empties over good stored enrichment, silently.
    return null;
  }
}

export async function formatUserData(
  data: IOnboardingPayload,
  extractService: ExtractService,
) {
  const record: IOnboardingPayload &
    Partial<{
      competitor: { title: string; url: string; id: string }[];
      userTitle: string[];
      websiteContent: string;
      channelId: string;
      channelDescription: string;
    }> = { ...data };

  // Each enrichment source is resolved independently and only when its input was
  // provided. This means onboarding succeeds off a channel URL alone (low
  // friction — the user's own channel is no longer coupled to `competitors`),
  // and a partial profile update never blanks unrelated stored data. All sources
  // run concurrently; each is best-effort and degrades to empty on failure.
  const jobs: Promise<void>[] = [];

  if (data.website) {
    jobs.push(
      extractService
        .getWebsiteContent(data.website)
        .then((content) => {
          record.websiteContent = content;
        })
        .catch(() => {
          // Same rule as the channel: don't overwrite stored content with "".
          delete record.websiteContent;
        }),
    );
  }

  // The user's own channel — id, top titles, and (3.5) the channel description
  // stored separately so the user-submitted `description` is never clobbered.
  if (data.userName) {
    jobs.push(
      resolveChannel(extractService, data.userName).then((channel) => {
        // Lookup failed — leave whatever is already stored alone.
        if (!channel) return;
        record.channelId = channel.id;
        record.channelDescription = channel.description;
        record.userTitle = channel.titles;
      }),
    );
  }

  if (data.competitors) {
    jobs.push(
      Promise.all(
        data.competitors.map(async (url: string) => {
          const channel = await resolveChannel(extractService, url);
          return { url, id: channel?.id ?? "", titles: channel?.titles ?? [] };
        }),
      ).then((competitors) => {
        record.competitors = competitors as unknown as typeof record.competitors;
      }),
    );
  }

  await Promise.all(jobs);

  return record;
}

export async function getClusteredTitles(
  userId: string,
  repo: ContentRepository,
) {
  // Bounded, projected read: active ideas only, title + embedding, capped at 200.
  const capped = (await repo.getIdeasForClustering(userId)) || [];
  const k = Math.min(8, Math.ceil(capped.length / 20));
  const titles: string[] = capped.map((doc) => doc.title) || [];
  const embeddings: number[][] = capped.map((doc) => doc.embedding) || [];

  if (titles.length <= k) {
    // If fewer titles than clusters, return all titles as one cluster
    return [titles];
  }

  // 2️⃣ Run KMeans clustering
  const { clusters } = kmeans(embeddings, k, {});

  // 3️⃣ Group titles by cluster
  const clusteredTitles: string[][] = Array.from({ length: k }, () => []);
  clusters.forEach((clusterIndex: number, i: number) => {
    clusteredTitles[clusterIndex].push(titles[i]);
  });

  // 4️⃣ Optionally: pick top N titles per cluster to feed AI
  const topN = 10;
  const result = clusteredTitles.map((cluster) => cluster.slice(0, topN));

  return result;
}
