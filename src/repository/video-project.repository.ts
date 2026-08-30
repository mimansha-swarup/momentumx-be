import { FieldPath, Firestore } from "firebase-admin/firestore";
import { COLLECTIONS } from "../constants/collection.js";
import { db, firebase } from "../config/firebase.js";
import {
  IVideoProject,
  OverallStatus,
  StaleReason,
  StepName,
  StepState,
} from "../types/routes/video-project.js";
import { STEP_ORDER } from "../constants/pipeline.js";
import { BadRequest, Conflict, Forbidden, NotFound } from "../utlils/errors.js";
import { RecordOwner } from "../utlils/content.js";
import { isDocumentId } from "../utlils/firestore-id.js";

interface ListOptions {
  status?: OverallStatus;
  limit: number;
  cursor?: string;
}

/**
 * What `acquireStep` must enforce, handed in by the caller.
 *
 * The repository owns atomicity; `constants/pipeline.ts` owns policy. Passing the
 * guard in keeps "which steps require what" out of the data layer, where it would
 * be invisible to anyone reading the pipeline definition.
 *
 * Named trade-off: this repository now throws `HttpError`. The alternative is a
 * result type the runner unpacks — more code for the same four failures, in
 * service of a layering purity that `utlils/errors.ts` (a shared util, not a
 * layer) does not ask for.
 */
export interface StepGuard {
  requires: readonly StepName[];
  lockMs: number;
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
    // Timestamp because `acquireStep` reads `.toMillis()` off it to evaluate the
    // lock, and the client never displays it.
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

  /**
   * Take the in-flight lock ATOMICALLY, and return the project as it was BEFORE
   * the write.
   *
   * Replaces the read-then-write pairs at `content.service.ts` and
   * `hooks.service.ts` — neither of which was a lock. Both read the step status,
   * decided it was free, and wrote `in_progress` in a separate call; two requests
   * could both read "free" and both proceed. Today that is a duplicate Gemini
   * call; once credits gate generation it is a double charge.
   *
   * Ownership check, precondition and lock all live INSIDE the transaction,
   * because a check performed outside it guarantees nothing about the write.
   *
   * The pre-write project is returned so callers can read `scriptId`/`hooksId`
   * for idempotent replay, and so the runner can capture prior state to restore
   * on failure.
   */
  acquireStep = async (
    projectId: string,
    step: StepName,
    // The OWNER object, not a bare `accountId: string`. `projectId`, `step` and
    // both ids are all strings, so a positional id here accepts whichever one the
    // caller happens to have — and during the Phase 06 flip the step runner did
    // exactly that, passing `actor.userId` into the account slot. It compiled, and
    // the check below would have refused every generation.
    owner: RecordOwner,
    guard: StepGuard
  ): Promise<IVideoProject> => {
    const ref = this.db.collection(this.collection).doc(projectId);

    return this.db.runTransaction(async (txn) => {
      const snap = await txn.get(ref);
      if (!snap.exists) throw NotFound("Video project not found");

      const project = this.hydrate(snap.data() as IVideoProject);
      if (project.isDeleted) throw NotFound("Video project not found");
      // Phase 06: the account, not the author. Inside the transaction, because a
      // check performed outside it guarantees nothing about the write.
      //
      // Deliberately a BARE `Forbidden()`, unlike the 18 service-layer checks
      // that now answer `wrong_account` or `account_forbidden`. This is a
      // backstop, not the client's answer: every caller reaches a step lock
      // through a service that has already loaded and ownership-checked the
      // project (`videoProjectService.getById`, before `steps.run`), so a
      // cross-channel caller is refused there with the discriminator. Resolving
      // membership here would mean a second read inside a transaction to
      // produce a message nobody receives.
      if (project.accountId !== owner.accountId) throw Forbidden();

      for (const required of guard.requires) {
        if (project.pipeline[required]?.status !== "completed") {
          throw BadRequest(
            `${required} must be completed before generating ${step}`
          );
        }
      }

      const state = project.pipeline[step];
      const startedMs = state?.startedAt?.toMillis?.() ?? 0;
      if (
        state?.status === "in_progress" &&
        Date.now() - startedMs < guard.lockMs
      ) {
        throw Conflict(`${step} generation already in progress for this project`);
      }

      // A completed step is left alone: regeneration paths re-enter here and must
      // not knock a finished step back to in_progress on the way.
      if (state?.status !== "completed") {
        const updates: Record<string, unknown> = {
          [`pipeline.${step}.status`]: "in_progress",
          [`pipeline.${step}.startedAt`]:
            firebase.firestore.FieldValue.serverTimestamp(),
        };
        // Only ever forward. completeStep has the mirror-image bug (it moves
        // currentStep backward unconditionally) — tracked separately.
        if (
          STEP_ORDER.indexOf(step) > STEP_ORDER.indexOf(project.currentStep)
        ) {
          updates["currentStep"] = step;
        }
        txn.update(ref, updates);
      }

      return project;
    });
  };

  /**
   * Restore a step to exactly what it was before `acquireStep`.
   *
   * Deliberately NOT "set it to not_started", which is what
   * `VideoProjectService.abandonStep` does: when the step being abandoned was
   * **stale**, hardcoding `not_started` silently clears the stale marker, so a
   * failed regenerate of a stale step leaves it looking fresh. Restoring captured
   * prior state fixes that for free.
   */
  releaseStep = async (
    projectId: string,
    step: StepName,
    prior: Pick<StepState, "status" | "startedAt"> & { staleReason?: StaleReason }
  ): Promise<void> => {
    const updates: Record<string, unknown> = {
      [`pipeline.${step}.status`]: prior.status,
      [`pipeline.${step}.startedAt`]: prior.startedAt ?? null,
    };
    // Only restore the reason when there was one; writing undefined would be
    // dropped by ignoreUndefinedProperties and leave a stale marker behind.
    if (prior.staleReason !== undefined) {
      updates[`pipeline.${step}.staleReason`] = prior.staleReason;
    }
    await this.db.collection(this.collection).doc(projectId).update(updates);
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

  update = async (
    projectId: string,
    data: Record<string, unknown>
  ): Promise<void> => {
    await this.db
      .collection(this.collection)
      .doc(projectId)
      .update({
        ...data,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      });
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
