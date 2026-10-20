// The role gate, COMPOSED — one real HTTP request per mutating route.
//
// Three things already exist and none of them prove this:
//   - tests/unit/middleware/role.behaviour.test.ts   → what requireRole DECIDES,
//     called directly with a fabricated req. It never goes through a router.
//   - tests/unit/auth-coverage.test.ts               → that the string
//     `requireRole("editor")` APPEARS in the route file. A source grep cannot see
//     ordering, cannot see a gate mounted after the controller, and cannot see a
//     handler registered on a second router that bypasses it.
//   - tests/unit/error-code-contract.behaviour.test.ts → that a RoleForbidden
//     thrown anywhere survives to the body. It throws from a bare probe app.
//
// The gap is the composition: a viewer sending a real request to a real route
// must get 403 **with `code: "role_forbidden"`** and the service must not run.
//
// Why the code and not just the status (.claude/rules/api-design.md → `code`):
//   role_forbidden    → inline message, the user STAYS in the channel
//   account_forbidden → the client clears the active channel and ejects the user
// A bare `expect(res.status).toBe(403)` passes for both. So the harm this file
// prevents is precise: a viewer who clicks a button the UI forgot to disable gets
// thrown out of a channel they are a legitimate member of.
//
// What this proves for real: `requireRole` is the REAL middleware, mounted by the
// REAL route files, and the refusal is produced by the real error handler. What it
// does NOT prove: that `req.role` is the caller's true role — that is
// accountMiddleware's job, tested in account-middleware.behaviour.test.ts.

jest.mock("../../src/middleware/account", () =>
  require("../helpers/account").passthroughAccountMiddleware()
);

jest.mock("firebase-admin", () => ({
  apps: [],
  initializeApp: jest.fn(),
  credential: { cert: jest.fn() },
  firestore: Object.assign(jest.fn().mockReturnValue({}), {
    FieldValue: { serverTimestamp: jest.fn().mockReturnValue({ _sentinel: "ts" }) },
    FieldPath: { documentId: jest.fn() },
  }),
  auth: jest.fn().mockReturnValue({ verifyIdToken: (...args: unknown[]) => mockVerifyIdToken(...args) }),
}));

const mockVerifyIdToken = jest.fn();

jest.mock("../../src/config/firebase", () => ({
  db: {},
  auth: { verifyIdToken: (...args: unknown[]) => mockVerifyIdToken(...args) },
  firebase: {
    firestore: {
      FieldValue: { serverTimestamp: jest.fn().mockReturnValue({ _sentinel: "ts" }) },
      FieldPath: { documentId: jest.fn() },
    },
    auth: jest.fn().mockReturnValue({ verifyIdToken: (...args: unknown[]) => mockVerifyIdToken(...args) }),
  },
}));

// Every service behind every gated route. They are mocked so "the gate ran before
// the work" is observable, and so an ungated route cannot reach Gemini or YouTube.
const svc = <T extends string>(...methods: T[]) =>
  Object.fromEntries(methods.map((m) => [m, jest.fn(async () => ({}))])) as Record<T, jest.Mock>;

const mockContentService = svc(
  "resolveOwner", "getPaginatedUsersIdeas", "generateIdeas", "saveBatchIdeas", "editIdeas",
  "regenerateAll", "regenerateOne", "exportIdeas", "generateScripts", "getUsersScript",
  "getScriptById", "editScript", "regenerateScript", "exportScript"
);
const mockHooksService = svc("generate", "select", "regenerate", "getById", "exportHooks");
const mockPackagingService = svc(
  "generateTitle", "generateDescription", "generateThumbnail", "generateShorts",
  "savePackaging", "getPackaging", "getPackagingByAccount", "regenerateItem",
  "selectTitle", "exportPackaging"
);
const mockUserService = svc(
  "createOnboardingData", "prefillFromChannel", "refreshContext", "getProfile", "updateProfile"
);
const mockVideoProjectService = svc(
  "create", "createFromTitle", "list", "getById", "getReconciledById", "update", "delete",
  "startStep", "completeStep", "linkResource", "markStale"
);
const mockResearchService = svc("getTrending", "getCompetitorInsights", "getKeywords");

const asModule = (instance: unknown) => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => instance),
});
jest.mock("../../src/service/content.service", () => asModule(mockContentService));
jest.mock("../../src/service/hooks.service", () => asModule(mockHooksService));
jest.mock("../../src/service/packaging.service", () => asModule(mockPackagingService));
jest.mock("../../src/service/user.service", () => asModule(mockUserService));
jest.mock("../../src/service/video-project.service", () => asModule(mockVideoProjectService));
jest.mock("../../src/service/research.service", () => asModule(mockResearchService));

import request from "supertest";
import type { Test } from "supertest";
import app from "../../src/app";
import { useSharedServer } from "./shared-server";
import { passthroughRole } from "../helpers/account";

const server = useSharedServer(app);

const AUTH_HEADER = ["Authorization", "Bearer valid-token"] as const;

const ALL_SERVICE_MOCKS = [
  mockContentService, mockHooksService, mockPackagingService,
  mockUserService, mockVideoProjectService, mockResearchService,
].flatMap((service) => Object.entries(service));

beforeEach(() => {
  mockVerifyIdToken.mockReset();
  mockVerifyIdToken.mockResolvedValue({ uid: "user-1" });
  // mockReset, not mockClear: clearMocks leaves the once-queue intact.
  ALL_SERVICE_MOCKS.forEach(([, fn]) => {
    fn.mockReset();
    fn.mockResolvedValue({});
  });
  // The SSE controller owns no response of its own — the service writes and ends
  // it. Left as a bare resolve, a request that WRONGLY gets past the gate hangs
  // until the jest timeout instead of failing on an assertion, which hides what
  // broke. Terminating here makes an ungated stream fail loudly as a 200 carrying
  // `data:` frames.
  mockContentService.generateScripts.mockImplementation(async (...args: unknown[]) => {
    const res = args[2] as { write: (s: string) => void; end: () => void };
    res.write("data: [DONE]\n\n");
    res.end();
  });
  passthroughRole.value = "owner";
});

// Shared module-level state: a test that threw before restoring it would run every
// later test as a viewer, turning one failure into a cascade that hides its cause.
afterEach(() => {
  passthroughRole.value = "owner";
});

const called = () => ALL_SERVICE_MOCKS.filter(([, fn]) => fn.mock.calls.length > 0).map(([name]) => name);

type Route = readonly [label: string, send: () => Test];

const req = () => request(server());

/**
 * Every route that MUTATES the channel or spends its shared quota.
 *
 * Bodies are the valid ones, so a refusal here is the gate and never validation.
 */
const EDITOR_ROUTES: readonly Route[] = [
  ["POST /v1/ideas/generate", () => req().post("/v1/ideas/generate").send({})],
  ["POST /v1/ideas/regenerate-all", () => req().post("/v1/ideas/regenerate-all")],
  ["PATCH /v1/ideas/edit/:ideaId", () => req().patch("/v1/ideas/edit/idea-1").send({ title: "New" })],
  ["POST /v1/ideas/:ideaId/regenerate", () => req().post("/v1/ideas/idea-1/regenerate")],

  ["PATCH /v1/scripts/edit/:scriptId", () => req().patch("/v1/scripts/edit/script-1").send({ script: "text" })],
  ["POST /v1/scripts/:scriptId/regenerate", () => req().post("/v1/scripts/script-1/regenerate")],

  ["POST /v1/hooks/generate", () => req().post("/v1/hooks/generate").send({ videoProjectId: "proj-1", script: "s" })],
  ["POST /v1/hooks/:hooksId/select", () => req().post("/v1/hooks/hooks-1/select").send({ hookIndex: 0 })],
  ["POST /v1/hooks/:hooksId/regenerate", () => req().post("/v1/hooks/hooks-1/regenerate").send({ script: "s" })],

  ["POST /v1/packaging/generate-title", () => req().post("/v1/packaging/generate-title").send({ script: "s" })],
  ["POST /v1/packaging/generate-description", () => req().post("/v1/packaging/generate-description").send({ script: "s", title: "T" })],
  ["POST /v1/packaging/generate-thumbnail", () => req().post("/v1/packaging/generate-thumbnail").send({ script: "s", title: "T" })],
  ["POST /v1/packaging/generate-shorts", () => req().post("/v1/packaging/generate-shorts").send({ script: "s", duration: 60 })],
  ["POST /v1/packaging/save", () => req().post("/v1/packaging/save").send({ description: "d" })],
  ["POST /v1/packaging/:id/regenerate/:item", () => req().post("/v1/packaging/pkg-1/regenerate/title").send({ script: "s" })],
  ["POST /v1/packaging/:id/select-title", () => req().post("/v1/packaging/pkg-1/select-title").send({ index: 0 })],

  ["POST /v1/video-projects", () => req().post("/v1/video-projects").send({ title: "T" })],
  ["PATCH /v1/video-projects/:projectId", () => req().patch("/v1/video-projects/proj-1").send({ title: "T" })],
  ["DELETE /v1/video-projects/:projectId", () => req().delete("/v1/video-projects/proj-1")],
  ["PATCH /v1/video-projects/:projectId/step/:stepName/complete", () => req().patch("/v1/video-projects/proj-1/step/script/complete")],
  ["PATCH /v1/video-projects/:projectId/link/:resourceType", () => req().patch("/v1/video-projects/proj-1/link/script").send({ resourceId: "script-1" })],

  ["POST /v1/user/onboarding/prefill", () => req().post("/v1/user/onboarding/prefill").send({ channelUrl: "https://www.youtube.com/@creator" })],
  ["PATCH /v1/user/onboarding", () => req().patch("/v1/user/onboarding").send({ niche: "fitness", targetAudience: "beginners" })],
  ["POST /v1/user/refresh-context", () => req().post("/v1/user/refresh-context")],
  ["PATCH /v1/user/profile", () => req().patch("/v1/user/profile").send({ brandName: "B" })],

  // Research spends the channel's shared YouTube quota, so it is editor-gated too
  // — at the router level rather than per route.
  ["GET /v1/research/trending", () => req().get("/v1/research/trending")],
  ["GET /v1/research/competitors", () => req().get("/v1/research/competitors")],
  ["GET /v1/research/keywords", () => req().get("/v1/research/keywords?query=ai")],
];

/** Reads and exports stay open to every member (api-design.md, Phase 09). */
const VIEWER_ROUTES: readonly Route[] = [
  ["GET /v1/ideas", () => req().get("/v1/ideas")],
  ["GET /v1/ideas/export", () => req().get("/v1/ideas/export")],
  ["GET /v1/scripts", () => req().get("/v1/scripts")],
  ["GET /v1/scripts/:scriptId", () => req().get("/v1/scripts/script-1")],
  ["GET /v1/scripts/:scriptId/export", () => req().get("/v1/scripts/script-1/export")],
  ["GET /v1/hooks/:hooksId", () => req().get("/v1/hooks/hooks-1")],
  ["GET /v1/hooks/:hooksId/export", () => req().get("/v1/hooks/hooks-1/export")],
  ["GET /v1/packaging/list", () => req().get("/v1/packaging/list")],
  ["GET /v1/packaging/:packagingId/export", () => req().get("/v1/packaging/pkg-1/export")],
  ["GET /v1/video-projects", () => req().get("/v1/video-projects")],
  ["GET /v1/video-projects/:projectId", () => req().get("/v1/video-projects/proj-1")],
  ["GET /v1/user/profile", () => req().get("/v1/user/profile")],
];

describe("a viewer is refused every mutation — with role_forbidden, never an eject", () => {
  it.each(EDITOR_ROUTES)("%s", async (_label, send) => {
    passthroughRole.value = "viewer";

    const res = await send().set(...AUTH_HEADER);

    expect(res.status).toBe(403);
    // The load-bearing half. `account_forbidden` here would clear the active
    // channel and eject a legitimate member to the channel list.
    expect(res.body).toMatchObject({ success: false, code: "role_forbidden", message: expect.any(String) });
    // Refused BEFORE the work: no generation, no write, no quota spent.
    expect(called()).toEqual([]);
  });

  // The SSE route cannot send headers, so its account (and role) come from the
  // PROJECT. The gate still has to fire, and it has to fire before flushHeaders —
  // a stream opened and then abandoned is a client that hangs.
  it("GET /v1/scripts/stream/:projectId", async () => {
    passthroughRole.value = "viewer";

    const res = await request(server()).get("/v1/scripts/stream/proj-1?token=valid-token");

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ success: false, code: "role_forbidden" });
    expect(res.text).not.toContain("data:");
    expect(mockContentService.generateScripts).not.toHaveBeenCalled();
  });
});

describe("the gate is a gate, not a wall", () => {
  it.each(EDITOR_ROUTES)("an editor reaches the service on %s", async (_label, send) => {
    passthroughRole.value = "editor";

    const res = await send().set(...AUTH_HEADER);

    // A route accidentally gated at `owner` would answer role_forbidden here, and
    // the whole channel would be read-only for its editors.
    expect(res.body.code).not.toBe("role_forbidden");
    expect(called().length).toBeGreaterThan(0);
  });

  it.each(VIEWER_ROUTES)("a viewer may still %s", async (_label, send) => {
    passthroughRole.value = "viewer";

    const res = await send().set(...AUTH_HEADER);

    // Refusing a viewer a READ is the mirror-image bug: the channel they were
    // invited to renders as empty rather than read-only.
    expect(res.body.code).not.toBe("role_forbidden");
    expect(res.status).not.toBe(403);
  });
});
