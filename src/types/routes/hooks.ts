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
  // Optional since 1D — resolved server-side from the project when omitted.
  script?: string;
}

export interface ISelectHookBody {
  hookIndex: number;
}

export interface IRegenerateHooksBody {
  // Optional since 1D — resolved server-side from the stored batch's project.
  script?: string;
}

export interface IHooksFeedbackBody {
  hookIndex: number;
  feedback: "like" | "dislike" | null;
}
