import { Timestamp } from "firebase-admin/firestore";

export interface IHooksBatch {
  id: string;
  videoProjectId: string;
  createdBy: string;
  /** Phase 03 dual-write. Stamped on create, read by nothing until Phase 06. */
  accountId?: string;
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
