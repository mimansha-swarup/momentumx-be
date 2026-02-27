// Integration tests for /v1/video-projects routes
// VideoProjectService is fully mocked -- no Firestore calls are made.

jest.mock("firebase-admin", () => ({
  apps: [],
  initializeApp: jest.fn(),
  credential: { cert: jest.fn() },
  firestore: Object.assign(jest.fn().mockReturnValue({}), {
    FieldValue: { serverTimestamp: jest.fn().mockReturnValue({ _sentinel: "ts" }) },
    FieldPath: { documentId: jest.fn() },
  }),
  auth: jest.fn().mockReturnValue({ verifyIdToken: jest.fn() }),
}));

jest.mock("../../src/config/firebase", () => ({
  db: {},
  auth: {},
  firebase: {
    firestore: {
      FieldValue: { serverTimestamp: jest.fn().mockReturnValue({ _sentinel: "ts" }) },
      FieldPath: { documentId: jest.fn() },
    },
    auth: jest.fn().mockReturnValue({ verifyIdToken: jest.fn() }),
  },
}));

// Replace authMiddleware with a simple stub that sets req.userId
jest.mock("../../src/middleware/auth", () => ({
  authMiddleware: (req: any, _res: any, next: any) => {
    req.userId = "test-user-id";
    next();
  },
}));

// Stable service mock instance (mock-prefix allows use in hoisted jest.mock factory)
const mockServiceInstance = {
  create: jest.fn(),
  list: jest.fn(),
  getById: jest.fn(),
  update: jest.fn(),
  delete: jest.fn(),
  startStep: jest.fn(),
  completeStep: jest.fn(),
  linkResource: jest.fn(),
  markStale: jest.fn(),
};

// Mock the service class so no repo/Firestore is touched
jest.mock("../../src/service/video-project.service", () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => mockServiceInstance),
}));

import request from "supertest";
import app from "../../src/app";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getService() {
  return mockServiceInstance;
}

function makeServiceError(message: string, statusCode: number) {
  const err = new Error(message) as any;
  err.statusCode = statusCode;
  return err;
}

const PROJECT_STUB = {
  id: "proj-1",
  userId: "test-user-id",
  workingTitle: "Test Video",
  topicId: "topic-1",
  scriptId: null,
  hooksId: null,
  packagingId: null,
  thumbnailHint: null,
  overallStatus: "in_progress",
  currentStep: "research",
  isDeleted: false,
  deletedAt: null,
  pipeline: {
    research: { status: "completed", startedAt: null, completedAt: null },
    script: { status: "not_started", startedAt: null, completedAt: null },
    hooks: { status: "not_started", startedAt: null, completedAt: null },
    packaging: { status: "not_started", startedAt: null, completedAt: null, items: {} },
  },
  createdAt: "2024-01-01",
  lastUpdatedAt: "2024-01-01",
};

// ---------------------------------------------------------------------------
// POST /v1/video-projects
// ---------------------------------------------------------------------------

describe("POST /v1/video-projects", () => {
  it("returns 201 with project data on success", async () => {
    getService().create.mockResolvedValueOnce(PROJECT_STUB as any);

    const res = await request(app)
      .post("/v1/video-projects")
      .send({ topicId: "topic-1" });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toBeDefined();
  });

  it("returns 400 when topicId is missing", async () => {
    const res = await request(app)
      .post("/v1/video-projects")
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it("returns 403 when service throws Forbidden", async () => {
    getService().create.mockRejectedValueOnce(makeServiceError("Forbidden", 403));

    const res = await request(app)
      .post("/v1/video-projects")
      .send({ topicId: "topic-1" });

    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
  });

  it("returns 404 when topic is not found", async () => {
    getService().create.mockRejectedValueOnce(makeServiceError("Topic not found", 404));

    const res = await request(app)
      .post("/v1/video-projects")
      .send({ topicId: "topic-missing" });

    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// GET /v1/video-projects
// ---------------------------------------------------------------------------

describe("GET /v1/video-projects", () => {
  it("returns 200 with project list", async () => {
    getService().list.mockResolvedValueOnce({
      projects: [PROJECT_STUB],
      hasMore: false,
      nextCursor: null,
    } as any);

    const res = await request(app).get("/v1/video-projects");

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.projects).toHaveLength(1);
  });

  it("returns 400 when service throws for invalid status", async () => {
    getService().list.mockRejectedValueOnce(makeServiceError("Invalid status value", 400));

    const res = await request(app).get("/v1/video-projects?status=bad");

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it("passes status, limit, cursor query params to service", async () => {
    getService().list.mockResolvedValueOnce({ projects: [], hasMore: false, nextCursor: null } as any);

    await request(app).get("/v1/video-projects?status=completed&limit=5&cursor=abc");

    expect(getService().list).toHaveBeenCalledWith(
      "test-user-id",
      expect.objectContaining({ status: "completed", limit: 5, cursor: "abc" })
    );
  });

  it("passes hasMore and nextCursor in response", async () => {
    getService().list.mockResolvedValueOnce({ projects: [], hasMore: true, nextCursor: "next" } as any);

    const res = await request(app).get("/v1/video-projects");

    expect(res.body.data.hasMore).toBe(true);
    expect(res.body.data.nextCursor).toBe("next");
  });
});

// ---------------------------------------------------------------------------
// GET /v1/video-projects/:projectId
// ---------------------------------------------------------------------------

describe("GET /v1/video-projects/:projectId", () => {
  it("returns 200 with project data", async () => {
    getService().getById.mockResolvedValueOnce(PROJECT_STUB as any);

    const res = await request(app).get("/v1/video-projects/proj-1");

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toBeDefined();
  });

  it("returns 404 when project not found", async () => {
    getService().getById.mockRejectedValueOnce(makeServiceError("Not found", 404));

    const res = await request(app).get("/v1/video-projects/missing");

    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
  });

  it("returns 403 when user does not own the project", async () => {
    getService().getById.mockRejectedValueOnce(makeServiceError("Forbidden", 403));

    const res = await request(app).get("/v1/video-projects/proj-other");

    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// PATCH /v1/video-projects/:projectId
// ---------------------------------------------------------------------------

describe("PATCH /v1/video-projects/:projectId", () => {
  it("returns 200 with updated workingTitle", async () => {
    getService().update.mockResolvedValueOnce({ workingTitle: "New Title" } as any);

    const res = await request(app)
      .patch("/v1/video-projects/proj-1")
      .send({ workingTitle: "New Title" });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it("returns 400 when workingTitle missing (service throws 400)", async () => {
    getService().update.mockRejectedValueOnce(makeServiceError("workingTitle is required", 400));

    const res = await request(app)
      .patch("/v1/video-projects/proj-1")
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it("returns 404 when project not found", async () => {
    getService().update.mockRejectedValueOnce(makeServiceError("Not found", 404));

    const res = await request(app)
      .patch("/v1/video-projects/missing")
      .send({ workingTitle: "Title" });

    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// DELETE /v1/video-projects/:projectId
// ---------------------------------------------------------------------------

describe("DELETE /v1/video-projects/:projectId", () => {
  it("returns 200 on success", async () => {
    getService().delete.mockResolvedValueOnce({ id: "proj-1", isDeleted: true } as any);

    const res = await request(app).delete("/v1/video-projects/proj-1");

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it("returns 404 when project not found", async () => {
    getService().delete.mockRejectedValueOnce(makeServiceError("Not found", 404));

    const res = await request(app).delete("/v1/video-projects/missing");

    expect(res.status).toBe(404);
  });

  it("returns 403 when user does not own the project", async () => {
    getService().delete.mockRejectedValueOnce(makeServiceError("Forbidden", 403));

    const res = await request(app).delete("/v1/video-projects/proj-other");

    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// PATCH /v1/video-projects/:projectId/step/:stepName/start
// ---------------------------------------------------------------------------

describe("PATCH /v1/video-projects/:projectId/step/:stepName/start", () => {
  it("returns 200 on success", async () => {
    getService().startStep.mockResolvedValueOnce({ id: "proj-1", currentStep: "script" } as any);

    const res = await request(app).patch("/v1/video-projects/proj-1/step/script/start");

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it("returns 200 on idempotent case (step already in_progress)", async () => {
    getService().startStep.mockResolvedValueOnce({ id: "proj-1", currentStep: "script" } as any);

    const res = await request(app).patch("/v1/video-projects/proj-1/step/script/start");

    expect(res.status).toBe(200);
  });

  it("returns 400 for invalid stepName", async () => {
    getService().startStep.mockRejectedValueOnce(makeServiceError("Invalid step", 400));

    const res = await request(app).patch("/v1/video-projects/proj-1/step/research/start");

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it("returns 404 when project not found", async () => {
    getService().startStep.mockRejectedValueOnce(makeServiceError("Not found", 404));

    const res = await request(app).patch("/v1/video-projects/missing/step/script/start");

    expect(res.status).toBe(404);
  });

  it("passes projectId, stepName, userId to service", async () => {
    getService().startStep.mockResolvedValueOnce({ id: "proj-42", currentStep: "hooks" } as any);

    await request(app).patch("/v1/video-projects/proj-42/step/hooks/start");

    expect(getService().startStep).toHaveBeenCalledWith("proj-42", "hooks", "test-user-id");
  });
});

// ---------------------------------------------------------------------------
// PATCH /v1/video-projects/:projectId/step/:stepName/complete
// ---------------------------------------------------------------------------

describe("PATCH /v1/video-projects/:projectId/step/:stepName/complete", () => {
  it("returns 200 on success", async () => {
    getService().completeStep.mockResolvedValueOnce({ id: "proj-1", currentStep: "hooks" } as any);

    const res = await request(app).patch("/v1/video-projects/proj-1/step/script/complete");

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it("returns 400 when step is not_started", async () => {
    getService().completeStep.mockRejectedValueOnce(
      makeServiceError("Cannot complete a step that has not been started", 400)
    );

    const res = await request(app).patch("/v1/video-projects/proj-1/step/script/complete");

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it("returns 400 for invalid stepName", async () => {
    getService().completeStep.mockRejectedValueOnce(makeServiceError("Invalid step", 400));

    const res = await request(app).patch("/v1/video-projects/proj-1/step/research/complete");

    expect(res.status).toBe(400);
  });

  it("returns 404 when project not found", async () => {
    getService().completeStep.mockRejectedValueOnce(makeServiceError("Not found", 404));

    const res = await request(app).patch("/v1/video-projects/missing/step/script/complete");

    expect(res.status).toBe(404);
  });

  it("passes projectId, stepName, userId to service", async () => {
    getService().completeStep.mockResolvedValueOnce({ id: "proj-42", currentStep: "packaging" } as any);

    await request(app).patch("/v1/video-projects/proj-42/step/hooks/complete");

    expect(getService().completeStep).toHaveBeenCalledWith("proj-42", "hooks", "test-user-id");
  });
});

// ---------------------------------------------------------------------------
// PATCH /v1/video-projects/:projectId/link/:resourceType
// ---------------------------------------------------------------------------

describe("PATCH /v1/video-projects/:projectId/link/:resourceType", () => {
  it("returns 200 on success", async () => {
    getService().linkResource.mockResolvedValueOnce({ id: "proj-1", scriptId: "script-abc" } as any);

    const res = await request(app)
      .patch("/v1/video-projects/proj-1/link/script")
      .send({ resourceId: "script-abc" });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it("returns 400 when resourceId is missing", async () => {
    const res = await request(app)
      .patch("/v1/video-projects/proj-1/link/script")
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toMatch(/resourceId/i);
  });

  it("returns 400 for invalid resourceType (service throws 400)", async () => {
    getService().linkResource.mockRejectedValueOnce(makeServiceError("Invalid resourceType", 400));

    const res = await request(app)
      .patch("/v1/video-projects/proj-1/link/invalid")
      .send({ resourceId: "res-1" });

    expect(res.status).toBe(400);
  });

  it("returns 403 when user does not own the project", async () => {
    getService().linkResource.mockRejectedValueOnce(makeServiceError("Forbidden", 403));

    const res = await request(app)
      .patch("/v1/video-projects/proj-1/link/script")
      .send({ resourceId: "script-abc" });

    expect(res.status).toBe(403);
  });

  it("returns 404 when project not found", async () => {
    getService().linkResource.mockRejectedValueOnce(makeServiceError("Not found", 404));

    const res = await request(app)
      .patch("/v1/video-projects/missing/link/script")
      .send({ resourceId: "script-abc" });

    expect(res.status).toBe(404);
  });

  it("passes projectId, resourceType, resourceId, userId to service", async () => {
    getService().linkResource.mockResolvedValueOnce({ id: "proj-1", packagingId: "pkg-xyz" } as any);

    await request(app)
      .patch("/v1/video-projects/proj-1/link/packaging")
      .send({ resourceId: "pkg-xyz" });

    expect(getService().linkResource).toHaveBeenCalledWith(
      "proj-1", "packaging", "pkg-xyz", "test-user-id"
    );
  });
});
