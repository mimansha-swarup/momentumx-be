import { randomUUID } from "crypto";

export const formatGeneratedTitle = (title: string, userId: string) => {
  return {
    id: randomUUID(),
    title,
    createdBy: userId || "",
    createdAt: new Date(),
    isScriptGenerated: false,
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

export function formatCreatorsData(creator) {
  // If it's a single object, wrap it in an array for uniform handling
  const list = [
    { url: creator?.userName, titles: creator?.userTitle },
    ...creator.competitors,
  ];

  let result = "";

  for (const creator of list) {
    const { url, titles = [] } = creator;

    result += `\n\n Video's of ${url}\n`;
    result += titles.map((title, i) => `   ${i + 1}. ${title}`).join("\n");
    result += "\n";
  }

  return result.trim();
}


