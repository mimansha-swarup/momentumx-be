// The in-flight lock itself — acquireStep / releaseStep.
//
// This suite exists because it did not, and nothing noticed. The service-level
// hooks tests assert 409-while-locked and 400-on-unmet-precondition against
// `tests/helpers/step-runner.ts`, a hand-written stand-in. Those assertions pass
// whether or not the real transaction below does anything at all: the whole of
// Phase 01b's atomicity claim rested on a fake.
//
// Firestore serializes the transaction; what is verified here is the decision
// logic inside it — who is refused, and what is written when nobody is.

const txnUpdate = jest.fn();
const txnGet = jest.fn();
const docUpdate = jest.fn();
const docFn = jest.fn((id: string) => ({ id, update: docUpdate }));
const collectionFn = jest.fn(() => ({ doc: docFn }));
const runTransaction = jest.fn(async (fn: (txn: unknown) => unknown) =>
  fn({ get: txnGet, update: txnUpdate })
);

jest.mock("../../../src/config/firebase", () => ({
  db: { collection: collectionFn, runTransaction },
  firebase: { firestore: { FieldValue: { serverTimestamp: () => "ts" } } },
}));

import VideoProjectRepository from "../../../src/repository/video-project.repository";
import { STEP_LOCK_MS } from "../../../src/constants/pipeline";

const step = (over: Record<string, unknown> = {}) => ({
  status: "not_started",
  startedAt: null,
  completedAt: null,
  ...over,
});

const project = (over: Record<string, unknown> = {}) => ({
  id: "proj-1",
  createdBy: "user-1",
  isDeleted: false,
  currentStep: "script",
  pipeline: {
    research: step({ status: "completed" }),
    script: step({ status: "completed" }),
    hooks: step(),
    title: step(),
    packaging: step(),
  },
  ...over,
});

const exists = (data: Record<string, unknown>) => ({ exists: true, data: () => data });

const GUARD = { requires: ["script"] as const, lockMs: STEP_LOCK_MS };

describe("VideoProjectRepository.acquireStep — refusals", () => {
  let repo: VideoProjectRepository;

  beforeEach(() => {
    jest.clearAllMocks();
    repo = new VideoProjectRepository();
  });

  it("404s on a missing project without writing", async () => {
    txnGet.mockResolvedValue({ exists: false });

    const err = await repo.acquireStep("proj-1", "hooks", "user-1", GUARD).catch((e) => e);

    expect(err.statusCode).toBe(404);
    expect(txnUpdate).not.toHaveBeenCalled();
  });

  it("404s on a soft-deleted project — deleted must not read as missing-but-usable", async () => {
    txnGet.mockResolvedValue(exists(project({ isDeleted: true })));

    const err = await repo.acquireStep("proj-1", "hooks", "user-1", GUARD).catch((e) => e);

    expect(err.statusCode).toBe(404);
    expect(txnUpdate).not.toHaveBeenCalled();
  });

  it("403s for a non-owner — the ownership check is INSIDE the transaction", async () => {
    txnGet.mockResolvedValue(exists(project()));

    const err = await repo.acquireStep("proj-1", "hooks", "intruder", GUARD).catch((e) => e);

    expect(err.statusCode).toBe(403);
    expect(txnUpdate).not.toHaveBeenCalled();
  });

  it("400s when a required upstream step is not completed", async () => {
    txnGet.mockResolvedValue(
      exists(project({ pipeline: { ...project().pipeline, script: step({ status: "in_progress" }) } }))
    );

    const err = await repo.acquireStep("proj-1", "hooks", "user-1", GUARD).catch((e) => e);

    expect(err.statusCode).toBe(400);
    expect(err.message).toMatch(/script must be completed/);
    expect(txnUpdate).not.toHaveBeenCalled();
  });

  it("409s while a fresh generation holds the lock", async () => {
    const startedAt = { toMillis: () => Date.now() - 1_000 };
    txnGet.mockResolvedValue(
      exists(project({ pipeline: { ...project().pipeline, hooks: step({ status: "in_progress", startedAt }) } }))
    );

    const err = await repo.acquireStep("proj-1", "hooks", "user-1", GUARD).catch((e) => e);

    expect(err.statusCode).toBe(409);
    expect(txnUpdate).not.toHaveBeenCalled();
  });

  it("lets a caller through once the lock has expired, so a crashed generation cannot wedge the step forever", async () => {
    const startedAt = { toMillis: () => Date.now() - STEP_LOCK_MS - 1 };
    txnGet.mockResolvedValue(
      exists(project({ pipeline: { ...project().pipeline, hooks: step({ status: "in_progress", startedAt }) } }))
    );

    await repo.acquireStep("proj-1", "hooks", "user-1", GUARD);

    expect(txnUpdate).toHaveBeenCalled();
  });
});

describe("VideoProjectRepository.acquireStep — what it writes", () => {
  let repo: VideoProjectRepository;

  beforeEach(() => {
    jest.clearAllMocks();
    repo = new VideoProjectRepository();
  });

  it("marks the step in_progress with a SERVER timestamp, using dotted paths so siblings survive", async () => {
    txnGet.mockResolvedValue(exists(project()));

    await repo.acquireStep("proj-1", "hooks", "user-1", GUARD);

    expect(txnUpdate.mock.calls[0][1]).toMatchObject({
      "pipeline.hooks.status": "in_progress",
      "pipeline.hooks.startedAt": "ts",
    });
  });

  it("advances currentStep forward", async () => {
    txnGet.mockResolvedValue(exists(project({ currentStep: "script" })));

    await repo.acquireStep("proj-1", "hooks", "user-1", GUARD);

    expect(txnUpdate.mock.calls[0][1].currentStep).toBe("hooks");
  });

  it("never moves currentStep backward — regenerating an early step must not rewind the pipeline", async () => {
    txnGet.mockResolvedValue(exists(project({ currentStep: "packaging" })));

    await repo.acquireStep("proj-1", "hooks", "user-1", GUARD);

    expect(txnUpdate.mock.calls[0][1]).not.toHaveProperty("currentStep");
  });

  it("returns the project as it was BEFORE the write, so callers can replay idempotently", async () => {
    txnGet.mockResolvedValue(exists(project({ hooksId: "hooks-9" })));

    const returned = await repo.acquireStep("proj-1", "hooks", "user-1", GUARD);

    expect(returned.hooksId).toBe("hooks-9");
    expect(returned.pipeline.hooks.status).toBe("not_started");
  });

  it("leaves a COMPLETED step untouched — re-entry must not knock it back to in_progress", async () => {
    txnGet.mockResolvedValue(
      exists(project({ pipeline: { ...project().pipeline, hooks: step({ status: "completed" }) } }))
    );

    await repo.acquireStep("proj-1", "hooks", "user-1", GUARD);

    // ponytail: known gap — no write means no lock either, so two concurrent
    // callers both pass here. Unreachable today (generate short-circuits on an
    // existing batch first). Recorded in phase-01b.
    expect(txnUpdate).not.toHaveBeenCalled();
  });

  it("back-fills pipeline.title for a legacy project instead of dereferencing undefined", async () => {
    const legacy = project();
    delete (legacy.pipeline as Record<string, unknown>).title;
    txnGet.mockResolvedValue(exists(legacy));

    const returned = await repo.acquireStep("proj-1", "hooks", "user-1", GUARD);

    expect(returned.pipeline.title.status).toBe("not_started");
  });
});

describe("VideoProjectRepository.releaseStep", () => {
  let repo: VideoProjectRepository;

  beforeEach(() => {
    jest.clearAllMocks();
    repo = new VideoProjectRepository();
  });

  it("restores the captured prior status rather than hardcoding not_started", async () => {
    await repo.releaseStep("proj-1", "hooks", { status: "stale", startedAt: null });

    expect(docUpdate).toHaveBeenCalledWith({
      "pipeline.hooks.status": "stale",
      "pipeline.hooks.startedAt": null,
    });
  });

  it("restores staleReason, so a failed regenerate of a stale step does not look fresh", async () => {
    await repo.releaseStep("proj-1", "hooks", {
      status: "stale",
      startedAt: null,
      staleReason: "script_regenerated",
    });

    expect(docUpdate.mock.calls[0][0]["pipeline.hooks.staleReason"]).toBe("script_regenerated");
  });

  it("omits staleReason entirely when there was none — writing undefined would be dropped and leave the old marker", async () => {
    await repo.releaseStep("proj-1", "hooks", { status: "not_started", startedAt: null });

    expect(docUpdate.mock.calls[0][0]).not.toHaveProperty("pipeline.hooks.staleReason");
  });
});

// Timestamps the client can actually render. This repository alone shipped raw
// Firestore Timestamps (`{_seconds, _nanoseconds}`) while packaging and ideas
// serialised theirs — against a frontend that types them as `string`, so
// `new Date(project.createdAt)` was Invalid Date and every dashboard card's
// "2 hours ago" rendered blank.
describe("VideoProjectRepository — timestamps are serialised on read", () => {
  let repo: VideoProjectRepository;
  const ts = (iso: string) => ({ toDate: () => new Date(iso) });

  beforeEach(() => {
    jest.clearAllMocks();
    repo = new VideoProjectRepository();
  });

  it("serialises createdAt and updatedAt on a point read", async () => {
    txnGet.mockResolvedValue(
      exists(project({ createdAt: ts("2026-08-01T10:00:00.000Z"), updatedAt: ts("2026-08-02T11:00:00.000Z") }))
    );

    const returned = await repo.acquireStep("proj-1", "hooks", "user-1", GUARD);

    expect(returned.createdAt).toBe("2026-08-01T10:00:00.000Z");
    expect(returned.updatedAt).toBe("2026-08-02T11:00:00.000Z");
  });

  it("leaves pipeline.<step>.startedAt as a Timestamp — the lock reads toMillis() off it", async () => {
    const startedAt = { toMillis: () => 1, toDate: () => new Date(1) };
    txnGet.mockResolvedValue(
      exists(project({
        createdAt: ts("2026-08-01T10:00:00.000Z"),
        pipeline: { ...project().pipeline, hooks: step({ status: "stale", startedAt }) },
      }))
    );

    const returned = await repo.acquireStep("proj-1", "hooks", "user-1", GUARD);

    // Serialising this one would break acquireStep's own lock-expiry arithmetic.
    expect(typeof (returned.pipeline.hooks.startedAt as { toMillis?: unknown })?.toMillis).toBe(
      "function"
    );
  });

  it("leaves a project that has no timestamps alone rather than throwing", async () => {
    txnGet.mockResolvedValue(exists(project()));

    const returned = await repo.acquireStep("proj-1", "hooks", "user-1", GUARD);

    expect(returned.createdAt).toBeUndefined();
  });
});
