import { Timestamp } from "firebase-admin/firestore";

export type StepStatus = "not_started" | "in_progress" | "completed" | "stale";
export type OverallStatus = "in_progress" | "completed" | "stale";
export type StepName = "research" | "script" | "hooks" | "packaging";
export type ResourceType = "script" | "hooks" | "packaging";
export type PackagingItemStatus = "not_started" | "completed" | "stale";
export type StaleReason = "research_regenerated" | "script_regenerated" | "hooks_regenerated" | null;

export interface StepState {
  status: StepStatus;
  startedAt: Timestamp | null;
  completedAt: Timestamp | null;
}

export interface IPackagingItemStatuses {
  title: PackagingItemStatus;
  description: PackagingItemStatus;
  thumbnail: PackagingItemStatus;
  shorts: PackagingItemStatus;
}

export interface IVideoProjectPipeline {
  research: StepState;
  script: StepState;
  hooks: StepState;
  packaging: StepState;
}

export interface IVideoProject {
  id: string;
  createdBy: string;
  title: string;
  ideaId: string;
  scriptId: string | null;
  hooksId: string | null;
  selectedHookIndex: number | null;
  packagingId: string | null;
  thumbnailHint: string | null;
  pipeline: IVideoProjectPipeline;
  overallStatus: OverallStatus;
  currentStep: StepName;
  // Read-time only (never stored): the guided-CTA target — the first non-completed
  // step, or null when the pipeline is done. Attached in reconcileView (6A.4).
  recommendedNextStep?: StepName | null;
  isDeleted: boolean;
  deletedAt: Timestamp | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface ICreateVideoProjectBody {
  ideaId?: string;
  title?: string;
}

export interface IUpdateVideoProjectBody {
  title?: string;
}

export interface ILinkResourceBody {
  resourceId: string;
}

export interface IListVideoProjectsQuery {
  status?: OverallStatus;
  limit?: number;
  cursor?: string;
}
