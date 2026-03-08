import { Timestamp } from "firebase-admin/firestore";

export interface IHooksBatch {
  id: string;
  videoProjectId: string;
  createdBy: string;
  hooks: string[];
  hookFeedback: Record<string, "like" | "dislike" | null>;
  createdAt: Timestamp;
}

export interface IGenerateHooksBody {
  videoProjectId: string;
  script: string;
}

export interface ISelectHookBody {
  hookIndex: number;
  videoProjectId: string;
}

export interface IRegenerateHooksBody {
  script: string;
}

export interface IHooksFeedbackBody {
  hookIndex: number;
  feedback: "like" | "dislike" | null;
}
