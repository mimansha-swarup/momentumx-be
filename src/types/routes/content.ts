import { Timestamp } from "firebase-admin/firestore";

export type UserFeedback = "like" | "dislike" | null;

// A topic document as stored in / read from Firestore (see formatGeneratedTitle).
export interface ITopic {
  id: string;
  title: string;
  createdBy: string;
  createdAt: Timestamp;
  updatedAt?: Timestamp;
  isScriptGenerated: boolean;
  embedding: number[];
  batchId: string | null;
  archived: boolean;
  videoProjectId: string | null;
  userFeedback: UserFeedback;
}

// A script document as stored in / read from Firestore (see formatGeneratedScript).
export interface IScript {
  id: string;
  title: string;
  createdBy: string;
  createdAt: Timestamp;
  script: string;
  topicId: string;
  videoProjectId: string | null;
  userFeedback?: UserFeedback;
}
