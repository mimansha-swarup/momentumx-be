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
