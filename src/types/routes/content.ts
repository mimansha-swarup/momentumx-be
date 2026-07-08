import { Timestamp } from "firebase-admin/firestore";

export type UserFeedback = "like" | "dislike" | null;
export type IdeaType = "long" | "short";

// What idea generation returns from the model (phase 2): a video CONCEPT.
// workingTitle is a plain-language handle, NOT an optimized headline —
// headline optimization happens post-script at the Title step.
export interface IGeneratedIdea {
  concept: string;
  workingTitle: string;
  type: IdeaType;
  evidence?: string;
}

// A topic document as stored in / read from Firestore (see formatGeneratedTitle /
// formatGeneratedIdea). `title` holds the idea's working title. The idea fields
// are optional: legacy docs and bring-your-own-title docs are title-only.
export interface ITopic {
  id: string;
  title: string;
  concept?: string | null;
  ideaType?: IdeaType | null;
  evidence?: string | null;
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
