import { randomUUID } from "crypto";
import { DocumentData } from "firebase-admin/firestore";
import { kmeans } from "ml-kmeans";
import { embeddingModel } from "src/config/ai";
import ContentRepository from "src/repository/content.repository";
import UserRepository from "src/repository/user.repository";
import ExtractService from "src/service/extract.service";

export const formatGeneratedTitle = async (title: string, userId: string) => {
  const embedding = await embeddingModel.embedContent(title);
  return {
    id: randomUUID(),
    title,
    createdBy: userId || "",
    createdAt: new Date(),
    isScriptGenerated: false,
    embedding: embedding.embedding.values,
  };
};
export const formatGeneratedScript = (
  title: string,
  id: string,
  script: string,
  userId: string
) => {
  return {
    id: id,
    title,
    createdBy: userId || "",
    createdAt: new Date(),
    script,
  };
};

export function formatCreatorsData(
  creator: DocumentData,
  similarTitles: string[]
) {
  // If it's a single object, wrap it in an array for uniform handling
  const list = [
    { url: creator?.userName, titles: creator?.userTitle },
    ...creator.competitors,
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

export async function formatUserData(
  data: IOnboardingPayload,
  extractService: ExtractService,
  repo: UserRepository
) {
  const record: IOnboardingPayload &
    Partial<{
      competitor: { title: string; url: string; id: string }[];
      userTitle: string[];
      websiteContent: string;
      channelId: string;
    }> = { ...data };

  const asyncList: Promise<unknown>[] = [];
  if (data.website) {
    asyncList.push(repo.getWebsiteContent(data.website));
  }
  if (data.competitors) {
    asyncList.push(
      ...[data.userName, ...record.competitors]?.map((competitorUrl) =>
        extractService.retrieveChannelId(competitorUrl)
      )
    );
  }
  const settledList = await Promise.allSettled(asyncList);

  let websiteContent;
  if (data.website) {
    websiteContent = settledList[0];
    settledList.shift();
  }
  const [userYTId, ...competitorId] = settledList;

  asyncList.length = 0;

  asyncList.push(
    ...[{ value: userYTId.value }, ...competitorId]?.map((competitor) =>
      extractService.getTopTenTitle(competitor.value?.id)
    )
  );
  const [userTitle, ...settledTitle] = await Promise.allSettled(asyncList);

  record.competitors = data.competitors?.map((url: string, idx: number) => {
    const idResult = competitorId[idx];
    const titleResult = settledTitle[idx];

    return {
      url,
      id:
        idResult && idResult.status === "fulfilled"
          ? (idResult.value?.id as string)
          : "",
      titles:
        titleResult && titleResult.status === "fulfilled"
          ? (titleResult.value as string[])
          : [],
    };
  });

  record.userTitle =
    userTitle && userTitle.status === "fulfilled"
      ? (userTitle.value as string[])
      : [];
  record.channelId =
    userYTId?.status === "fulfilled" ? (userYTId?.value?.id as string) : "";
  record.description =
    userYTId?.status === "fulfilled"
      ? (userYTId?.value?.description as string)
      : "";
  record.websiteContent =
    websiteContent?.status === "fulfilled"
      ? (websiteContent?.value as string)
      : "";

  return record;
}

export async function getClusteredTitles(
  userId: string,
  repo: ContentRepository
) {
  // 1️⃣ Fetch all titles + embeddings
  const titleRecord = await repo.getAllTopics({ userId });
  const k = Math.min(8, Math.ceil(titleRecord.length / 20));
  // console.log("ttitleRecord", titleRecord)
  const titles: string[] = titleRecord?.map((doc) => doc.title) || [];
  const embeddings: number[][] = titleRecord?.map((doc) => doc.embedding) || [];

  console.log(titles.length, "swarup");
  if (titles.length <= k) {
    // If fewer titles than clusters, return all titles as one cluster
    return [titles];
  }

  // 2️⃣ Run KMeans clustering
  const { clusters } = kmeans(embeddings, k);

  // 3️⃣ Group titles by cluster
  const clusteredTitles = Array.from({ length: k }, () => []);
  clusters.forEach((clusterIndex, i) => {
    clusteredTitles[clusterIndex].push(titles[i]);
  });

  // 4️⃣ Optionally: pick top N titles per cluster to feed AI
  const topN = 10;
  const result = clusteredTitles.map((cluster) => cluster.slice(0, topN));

  return result;
}
