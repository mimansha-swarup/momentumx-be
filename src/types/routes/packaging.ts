import { Timestamp } from "firebase-admin/firestore";
import { IPackagingItemStatuses, StaleReason } from "./video-project.js";

export type PackagingItemName = "title" | "description" | "thumbnail" | "shorts";
export type PackagingFeedback = "like" | "dislike" | null;

export interface IPackagingTitle {
  title: string;
  characterCount?: number;
}

export interface IShortsSegment {
  startTime?: string;
  endTime?: string;
  type?: string;
  content?: string;
}

export interface IPackagingShorts {
  segments: IShortsSegment[];
  // The generator emits a human-readable duration (e.g. "58 seconds").
  totalDuration?: string;
}

/**
 * Canonical packaging document (see PackagingService.normalizeField for the
 * coercion rules that guarantee these shapes at every write).
 */
export interface IPackaging {
  id: string;
  createdBy: string;
  videoProjectId: string | null;
  titles: IPackagingTitle[];
  description: string;
  thumbnail: string[];
  shorts: IPackagingShorts | null;
  itemStatuses: IPackagingItemStatuses;
  isStale: boolean;
  staleReason: StaleReason;
  staleSince: Timestamp | Date | null;
  feedback?: Partial<Record<PackagingItemName, PackagingFeedback>>;
  createdAt?: Timestamp | Date;
  updatedAt?: Timestamp | Date;
}
