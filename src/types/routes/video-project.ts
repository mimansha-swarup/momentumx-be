import { Timestamp } from "firebase-admin/firestore";

export type StepStatus = "not_started" | "in_progress" | "completed" | "stale";
export type OverallStatus = "in_progress" | "completed" | "stale";

// StepName is derived from STEP_ORDER in constants/pipeline.ts so the list of
// steps exists exactly once. Imported and re-exported here because ~20 files
// already take it from this module, and a rename would be churn with no benefit.
import type { StepName } from "../../constants/pipeline.js";
export type { StepName };
export type ResourceType = "script" | "hooks" | "packaging";
export type PackagingItemStatus = "not_started" | "completed" | "stale";
export type StaleReason =
  | "research_regenerated"
  | "script_regenerated"
  | "hooks_regenerated"
  | "title_regenerated"
  | null;

export interface StepState {
  status: StepStatus;
  startedAt: Timestamp | null;
  completedAt: Timestamp | null;
  // Which upstream step invalidated this one. Without it the screens had nothing
  // to read and hardcoded "the script has been regenerated" — routinely telling
  // the creator the wrong thing changed.
  staleReason?: StaleReason;
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
  // Post-script Title step: generate options (in_progress) → select one (completed).
  // The selected title becomes the project's display title and seeds packaging.
  title: StepState;
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
