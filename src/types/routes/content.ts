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

// Instant-first-idea (3.3): a transient, not-yet-persisted channel context the
// client can pass to idea generation (from the onboarding prefill, possibly
// user-edited), so a user sees their first ideas before onboarding is saved.
// Every field optional — it is merged over the stored user record, override wins.
export interface IIdeaContextOverride {
  niche?: string;
  targetAudience?: string;
  brandName?: string;
  topTitles?: string[];
}

// A idea document as stored in / read from Firestore (see formatGeneratedTitle /
// formatGeneratedIdea). `title` holds the idea's working title. The idea fields
// are optional: legacy docs and bring-your-own-title docs are title-only.
export interface IIdea {
  id: string;
  title: string;
  /**
   * The channel this record belongs to (Phase 03 writes it, Phase 06 reads it).
   *
   * REQUIRED, and it is the permission field — `createdBy` is authorship only.
   * Optional here would make `doc.accountId !== owner.accountId` compile against
   * a document type that admits `undefined`, which is the comparison silently
   * passing for a record nobody can prove belongs anywhere.
   */
  accountId: string;
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
  /**
   * The channel this record belongs to (Phase 03 writes it, Phase 06 reads it).
   *
   * REQUIRED, and it is the permission field — `createdBy` is authorship only.
   * Optional here would make `doc.accountId !== owner.accountId` compile against
   * a document type that admits `undefined`, which is the comparison silently
   * passing for a record nobody can prove belongs anywhere.
   */
  accountId: string;
  createdBy: string;
  createdAt: Timestamp;
  script: string;
  ideaId: string;
  videoProjectId: string | null;
  userFeedback?: UserFeedback;
}
