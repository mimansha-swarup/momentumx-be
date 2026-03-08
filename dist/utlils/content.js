import { randomUUID } from "crypto";
import { kmeans } from "ml-kmeans";
import { embeddingModel } from "../config/ai.js";
import { firebase } from "../config/firebase.js";
export const formatGeneratedTitle = async (title, userId, batchId) => {
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
export const formatGeneratedScript = (title, id, script, userId) => {
    return {
        id: id,
        title,
        createdBy: userId || "",
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
        script,
    };
};
export function formatCreatorsData(creator, similarTitles) {
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
export async function formatUserData(data, extractService, repo) {
    const record = { ...data };
    const asyncList = [];
    if (data.website) {
        asyncList.push(repo.getWebsiteContent(data.website));
    }
    if (data.competitors) {
        asyncList.push(...[data.userName, ...record.competitors]?.map((competitorUrl) => extractService.retrieveChannelId(competitorUrl)));
    }
    const settledList = await Promise.allSettled(asyncList);
    let websiteContent;
    if (data.website) {
        websiteContent = settledList[0];
        settledList.shift();
    }
    const [userYTId, ...competitorId] = settledList;
    asyncList.length = 0;
    asyncList.push(...[{ value: userYTId.status === 'fulfilled' ? userYTId.value : undefined }, ...competitorId]?.map((competitor) => extractService.getTopTenTitle(competitor.value?.id)));
    const [userTitle, ...settledTitle] = await Promise.allSettled(asyncList);
    record.competitors = data.competitors?.map((url, idx) => {
        const idResult = competitorId[idx];
        const titleResult = settledTitle[idx];
        return {
            url,
            id: idResult && idResult.status === "fulfilled"
                ? idResult.value?.id
                : "",
            titles: titleResult && titleResult.status === "fulfilled"
                ? titleResult.value
                : [],
        };
    });
    record.userTitle =
        userTitle && userTitle.status === "fulfilled"
            ? userTitle.value
            : [];
    record.channelId =
        userYTId?.status === "fulfilled" ? userYTId.value?.id : "";
    record.description =
        userYTId?.status === "fulfilled"
            ? userYTId.value?.description
            : "";
    record.websiteContent =
        websiteContent?.status === "fulfilled"
            ? websiteContent?.value
            : "";
    return record;
}
export async function getClusteredTitles(userId, repo) {
    // 1️⃣ Fetch all titles + embeddings
    const titleRecord = await repo.getAllTopics({ userId });
    const k = Math.min(8, Math.ceil(titleRecord.length / 20));
    // console.log("ttitleRecord", titleRecord)
    const titles = titleRecord?.map((doc) => doc.title) || [];
    const embeddings = titleRecord?.map((doc) => doc.embedding) || [];
    console.log(titles.length, "swarup");
    if (titles.length <= k) {
        // If fewer titles than clusters, return all titles as one cluster
        return [titles];
    }
    // 2️⃣ Run KMeans clustering
    const { clusters } = kmeans(embeddings, k, {});
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
