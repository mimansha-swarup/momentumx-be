import { Timestamp } from "firebase-admin/firestore";

export interface IHooksBatch {
  id: string;
  videoProjectId: string;
  createdBy: string;
  /**
   * The channel this record belongs to (Phase 03 writes it, Phase 06 reads it).
   *
   * REQUIRED, and it is the permission field — `createdBy` is authorship only.
   * Optional here would make `doc.accountId !== owner.accountId` compile against
   * a document type that admits `undefined`, which is the comparison silently
   * passing for a record nobody can prove belongs anywhere.
   */
  accountId: string;
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
