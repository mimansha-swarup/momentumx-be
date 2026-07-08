import { randomUUID } from "crypto";
import { DocumentData } from "firebase-admin/firestore";
import { kmeans } from "ml-kmeans";
import { embeddingModel } from "../config/ai.js";
import { firebase } from "../config/firebase.js";
import ContentRepository from "../repository/content.repository.js";
import ExtractService from "../service/extract.service.js";
import { IGeneratedIdea } from "../types/routes/content.js";

function extractChannelField(value: unknown, field: "id" | "description"): string {
  if (typeof value === "string") return field === "id" ? value : "";
  if (value && typeof value === "object" && field in value) {
    return ((value as Record<string, unknown>)[field] as string) ?? "";
  }
  return "";
}

export const formatGeneratedTitle = async (title: string, userId: string, batchId?: string) => {
  const embedding = await embeddingModel.embedContent(title);
  return {
    id: randomUUID(),
    title,
    createdBy: userId || "",
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
  userId: string,
  batchId?: string,
) => {
  const base = await formatGeneratedTitle(idea.workingTitle, userId, batchId);
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
  topicId: string,
  videoProjectId: string,
  script: string,
  userId: string,
) => {
  return {
    id: scriptId,
    title,
    createdBy: userId || "",
    createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    script,
    topicId,
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
// throws, so a single bad channel can't fail onboarding.
async function resolveChannel(
  extractService: ExtractService,
  url: string,
): Promise<{ id: string; description: string; titles: string[] }> {
  try {
    const info = await extractService.retrieveChannelId(url);
    const id = extractChannelField(info, "id");
    const description = extractChannelField(info, "description");
    const titles = id ? (await extractService.getTopTenTitle(id)) ?? [] : [];
    return { id, description, titles };
  } catch {
    return { id: "", description: "", titles: [] };
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
          record.websiteContent = "";
        }),
    );
  }

  // The user's own channel — id, top titles, and (3.5) the channel description
  // stored separately so the user-submitted `description` is never clobbered.
  if (data.userName) {
    jobs.push(
      resolveChannel(extractService, data.userName).then((channel) => {
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
          return { url, id: channel.id, titles: channel.titles };
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
  // Bounded, projected read: active topics only, title + embedding, capped at 200.
  const capped = (await repo.getTopicsForClustering(userId)) || [];
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
