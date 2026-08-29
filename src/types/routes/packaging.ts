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
  videoProjectId: string | null;
  titles: IPackagingTitle[];
  // §7.3: the Title variation the user finalized; promoted to the project's
  // display title. Absent/null until they pick one.
  selectedTitleIndex?: number | null;
  description: string;
  thumbnail: string[];
  // Which thumbnail brief the user picked; drives the project's thumbnailHint.
  selectedThumbnailIndex?: number | null;
  shorts: IPackagingShorts | null;
  itemStatuses: IPackagingItemStatuses;
  isStale: boolean;
  staleReason: StaleReason;
  staleSince: Timestamp | Date | null;
  feedback?: Partial<Record<PackagingItemName, PackagingFeedback>>;
  createdAt?: Timestamp | Date;
  updatedAt?: Timestamp | Date;
}
