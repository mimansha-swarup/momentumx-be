import { Timestamp } from "firebase-admin/firestore";

export type StepStatus = "not_started" | "in_progress" | "completed" | "stale";
export type OverallStatus = "in_progress" | "completed" | "stale";
export type StepName = "research" | "script" | "hooks" | "packaging";
export type ResourceType = "script" | "hooks" | "packaging";

export interface StepState {
  status: StepStatus;
  startedAt: Timestamp | null;
  completedAt: Timestamp | null;
}

export interface PackagingStepState extends StepState {
  items: {
    titles: string;
    description: string;
    thumbnail: string;
    shorts: string;
  };
}

export interface IVideoProjectPipeline {
  research: StepState;
  script: StepState;
  hooks: StepState;
  packaging: PackagingStepState;
}

export interface IVideoProject {
  id: string;
  userId: string;
  workingTitle: string;
  topicId: string;
  scriptId: string | null;
  hooksId: string | null;
  packagingId: string | null;
  thumbnailHint: string | null;
  pipeline: IVideoProjectPipeline;
  overallStatus: OverallStatus;
  currentStep: StepName;
  isDeleted: boolean;
  deletedAt: Timestamp | null;
  createdAt: Timestamp;
  lastUpdatedAt: Timestamp;
}

export interface ICreateVideoProjectBody {
  topicId: string;
}

export interface IUpdateVideoProjectBody {
  workingTitle?: string;
}

export interface ILinkResourceBody {
  resourceId: string;
}

export interface IListVideoProjectsQuery {
  status?: OverallStatus;
  limit?: number;
  cursor?: string;
}
