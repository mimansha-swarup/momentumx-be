import { Timestamp } from "firebase-admin/firestore";

export interface IHooksBatch {
  id: string;
  videoProjectId: string;
  createdBy: string;
  hooks: string[];
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
