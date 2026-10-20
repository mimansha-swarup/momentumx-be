import type { CreditReservation } from "./billing.repository.js";
import { assertGeneration, generationWrite } from "./generation-guard.js";
import { FieldPath, Firestore } from "firebase-admin/firestore";
import { COLLECTIONS } from "../constants/collection.js";
import { db, firebase } from "../config/firebase.js";
import {
  IVideoProject,
  StepName,
  OverallStatus,
} from "../types/routes/video-project.js";
import { isDocumentId } from "../utlils/firestore-id.js";

interface ListOptions {
  status?: OverallStatus;
  limit: number;
  cursor?: string;
}

class VideoProjectRepository {
  private collection: `${COLLECTIONS}`;
  private db: Firestore;

  constructor() {
    this.db = db;
    this.collection = COLLECTIONS.VIDEO_PROJECTS;
  }

  // Back-compat: projects created before Title became a pipeline step lack
  // pipeline.title. Default it on read so step logic (STEP_ORDER, stale cascade,
  // startStep/completeStep) never dereferences an undefined step.
  private hydrate = (project: IVideoProject): IVideoProject => {
    const pipeline = project.pipeline as { title?: unknown } | undefined;
    if (pipeline && !pipeline.title) {
      project.pipeline.title = { status: "not_started", startedAt: null, completedAt: null };
    }

    // Serialise the document's own timestamps, which this repository alone did
    // not. Packaging (`packaging.repository.ts`) and ideas (`content.service.ts`)
    // both convert; video projects shipped raw Firestore Timestamps
    // (`{_seconds, _nanoseconds}`) against a frontend that types them as `string`
    // — so `new Date(project.createdAt)` was Invalid Date and every dashboard
    // card's "2 hours ago" rendered blank.
    //
    // Only the two document-level fields. `pipeline.<step>.startedAt` stays a
    // Timestamp because pipeline transitions preserve their stored shape;
    // the client never displays these.
    for (const field of ["createdAt", "updatedAt"] as const) {
      const value = (project as unknown as Record<string, unknown>)[field] as
        | { toDate?: () => Date }
        | undefined;
      if (value?.toDate) {
        (project as unknown as Record<string, unknown>)[field] = value.toDate().toISOString();
      }
    }

    return project;
  };

  create = async (data: Record<string, unknown>): Promise<IVideoProject> => {
    const docRef = this.db.collection(this.collection).doc();
    const dataWithId = { ...data, id: docRef.id };
    await docRef.set(dataWithId);
    return dataWithId as IVideoProject;
  };

  /**
   * The SSE account-bootstrap read, deliberately NOT account-filtered.
   *
   * `resolveAccountFromProject` has to read the project before it can know which
   * account to check, so this one read cannot be scoped. It has its own name so
   * that when Phase 06 makes `findById` account-filtered, the exception is
   * visible at the call site instead of being silently inherited.
   */
  findByIdUnchecked = async (projectId: string): Promise<IVideoProject | null> =>
    this.findById(projectId);

  findById = async (projectId: string): Promise<IVideoProject | null> => {
    // A route param reaching `.doc()` unchecked: `GET /v1/…/a%2Fb` decodes to
    // "a/b", which addresses a COLLECTION and throws a bare Error — rendered as
    // 500 "Something went wrong" where the honest answer is not-found.
    if (!isDocumentId(projectId)) return null;
    const doc = await this.db.collection(this.collection).doc(projectId).get();
    if (!doc.exists) return null;
    return this.hydrate(doc.data() as IVideoProject);
  };

  list = async (
    accountId: string,
    { status, limit, cursor }: ListOptions
  ): Promise<{ projects: IVideoProject[]; hasMore: boolean; nextCursor: string | null }> => {
    let query = this.db
      .collection(this.collection)
      .where("accountId", "==", accountId)
      .where("isDeleted", "==", false);

    if (status) {
      query = query.where("overallStatus", "==", status);
    }

    query = query
      .orderBy("updatedAt", "desc")
      .orderBy(FieldPath.documentId(), "desc");

    if (cursor) {
      // The one read in this file that is not account-scoped, and it was a
      // cross-account existence oracle: `?cursor=<any project id>` answered 200
      // while a random id answered 400, so any authenticated caller could
      // confirm ids belonging to channels they have never been a member of.
      // `isDocumentId` first, because a cursor is a client string reaching
      // `.doc()` exactly like `X-Account-Id` was.
      const cursorDoc = isDocumentId(cursor)
        ? await this.db.collection(this.collection).doc(cursor).get()
        : null;

      if (!cursorDoc?.exists || cursorDoc.data()?.accountId !== accountId) {
        const err = new Error("Invalid cursor") as Error & { statusCode: number };
        err.statusCode = 400;
        throw err;
      }
      query = query.startAfter(cursorDoc);
    }

    // Fetch one extra to determine hasMore
    const snapshot = await query.limit(limit + 1).get();
    const docs = snapshot.docs;
    const hasMore = docs.length > limit;
    const resultDocs = hasMore ? docs.slice(0, limit) : docs;

    // Through hydrate, like every other read path — the list is what the
    // dashboard renders, so it is the one that most needs serialised timestamps
    // and a back-filled pipeline.title.
    const projects = resultDocs.map((doc) => this.hydrate(doc.data() as IVideoProject));
    const nextCursor = hasMore ? resultDocs[resultDocs.length - 1].id : null;

    return { projects, hasMore, nextCursor };
  };

  /**
   * Apply a status repair ONLY if the statuses it was computed from are still current.
   *
   * `getReconciledById` reads, computes repairs, then writes — last-writer-wins. A
   * `markStale` landing in that gap was silently erased: the dotted-path write reset
   * `pipeline.<step>.status` to "completed" while the concurrent write's `staleReason`
   * survived, leaving a project that is completed AND carries a stale reason, so the
   * user ships packaging built from a script they have since regenerated.
   *
   * Same shape as `account.repository.updateIfOwner`: the check belongs INSIDE the
   * write, not before it. Returns false when it declined, so the caller can serve the
   * fresh view rather than its own stale computation.
   */
  updateIfStatusesUnchanged = async (
    projectId: string,
    expected: Record<string, string>,
    data: Record<string, unknown>
  ): Promise<boolean> => {
    const ref = this.db.collection(this.collection).doc(projectId);
    return this.db.runTransaction(async (txn) => {
      const current = (await txn.get(ref)).data() as IVideoProject | undefined;
      if (!current) return false;
      for (const [step, status] of Object.entries(expected)) {
        if (current.pipeline?.[step as StepName]?.status !== status) return false;
      }
      txn.update(ref, { ...data, updatedAt: firebase.firestore.FieldValue.serverTimestamp() });
      return true;
    });
  };

  update = async (projectId: string, data: Record<string, unknown>, charge?: CreditReservation | null): Promise<void> => {
    const ref = this.db.collection(this.collection).doc(projectId);
    const patch = { ...data, updatedAt: firebase.firestore.FieldValue.serverTimestamp() };
    if (charge) await generationWrite(charge, tx => tx.update(ref, patch));
    else await ref.update(patch);
  };

  /**
   * How many live projects this channel holds (Phase 06a's `projectCount`).
   *
   * An aggregation, not a fetch: the switcher asks for this on every channel the
   * user belongs to, and reading whole project documents to discard all but the
   * length would scale that by the size of the biggest channel. `count()` is
   * billed at a fraction of a read per index entry.
   */
  countForAccount = async (accountId: string): Promise<number> => {
    const snap = await this.db
      .collection(this.collection)
      .where("accountId", "==", accountId)
      .where("isDeleted", "==", false)
      .count()
      .get();
    return snap.data().count;
  };

  findByIdeaId = async (ideaId: string, accountId: string): Promise<IVideoProject[]> => {
    // Equality-only filters (no orderBy) so no composite index is required.
    const snap = await this.db.collection(this.collection)
      .where("accountId", "==", accountId)
      .where("ideaId", "==", ideaId)
      .where("isDeleted", "==", false)
      .get();
    return snap.docs.map((doc) => this.hydrate(doc.data() as IVideoProject));
  };

  findByScriptId = async (scriptId: string, accountId: string): Promise<IVideoProject | null> => {
    const snap = await this.db.collection(this.collection)
      .where("scriptId", "==", scriptId)
      .where("accountId", "==", accountId)
      .where("isDeleted", "==", false)
      .limit(1)
      .get();
    if (snap.empty) return null;
    return this.hydrate(snap.docs[0].data() as IVideoProject);
  };
}

export default VideoProjectRepository;
