// Behaviour-driven integration tests for /v1/packaging (routes + controller).
//
// Contract derived FIRST from .claude/rules/api-design.md (response envelope,
// "Owning IDs" rule, packagingSaveSchema key-allowlisting) and
// docs/features/packaging/api.md, then checked against
// src/controller/packaging.controller.ts + src/routes/v1/packaging.route.ts.
// PackagingService is mocked at the module boundary; src/container.ts wires
// the real class into packagingController.

// Route suites mock Firestore away, so the real account middleware (which reads
// the account document to verify membership) cannot run. Membership behaviour is
// tested in tests/integration/account-middleware.behaviour.test.ts; that each
// router still MOUNTS it is pinned by tests/unit/auth-coverage.test.ts.
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

const mockPackagingService = {
  generateTitle: jest.fn(),
  generateDescription: jest.fn(),
  generateThumbnail: jest.fn(),
  generateShorts: jest.fn(),
  savePackaging: jest.fn(),
  getPackaging: jest.fn(),
  getPackagingByAccount: jest.fn(),
  regenerateItem: jest.fn(),
  selectTitle: jest.fn(),
  exportPackaging: jest.fn(),
};

jest.mock("../../src/service/packaging.service", () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => mockPackagingService),
}));

import request from "supertest";
import app from "../../src/app";
import { AccountForbidden, NotFound, WrongAccount } from "../../src/utlils/errors";
import { useSharedServer } from "./shared-server";
import { testOwner, OTHER_ACCOUNT_ID, TEST_ACCOUNT_ID } from "../helpers/account";

// One HTTP server for the whole file. `request(app)` starts and tears down a
// FRESH ephemeral server per call; across ~113 requests that intermittently
// produced connection-level failures (a 501 from Node with an empty body, once a
// socket hang up) on an arbitrary test, never reproducible in isolation.
const server = useSharedServer(app);

const AUTH_HEADER = ["Authorization", "Bearer valid-token"] as const;

/**
 * The canonical title shape (`normalizeField("titles", …)`): `{ title,
 * characterCount }`. Used so the fixtures below are what the service can
 * actually return.
 */
const TITLES = [
  { title: "The 3-Ingredient Dinner", characterCount: 23 },
  { title: "I Cooked For 100 People", characterCount: 23 },
  { title: "Never Buy Pasta Again", characterCount: 21 },
];

beforeEach(() => {
  mockVerifyIdToken.mockReset();
  mockVerifyIdToken.mockResolvedValue({ uid: "user-1" });

  // Drain any queued `mockResolvedValueOnce`. `clearMocks: true` calls
  // mockClear(), which resets call history but LEAVES the once-queue intact — so
  // a test whose request short-circuits before reaching the service (a 400 from
  // validation, a 404 thrown upstream) leaves its queued value for whichever
  // test calls that mock next. That produced intermittent, order-dependent
  // failures on a different test each run. mockReset() drains the queue.
  Object.values(mockPackagingService).forEach((fn) => (fn as jest.Mock).mockReset());
});

// ---------------------------------------------------------------------------
// POST /v1/packaging/generate-title
// ---------------------------------------------------------------------------

describe("POST /v1/packaging/generate-title", () => {
  it("returns the title variations themselves on the stateless preview path", async () => {
    // Without a videoProjectId this is a preview: the raw generation, no persist
    // and so no packagingId (packaging.service.ts → `if (!videoProjectId) return raw`).
    mockPackagingService.generateTitle.mockResolvedValueOnce({ titles: TITLES });

    const res = await request(server())
      .post("/v1/packaging/generate-title")
      .set(...AUTH_HEADER)
      .send({ script: "the script" });

    expect(res.status).toBe(200);
    // `titles: expect.any(Array)` passed on `[]` — a generation that produced
    // nothing, reported as success, rendering three blank cards.
    expect(res.body.data.titles).toEqual(TITLES);
  });

  it("returns 400 when neither script nor videoProjectId is provided", async () => {
    const res = await request(server()).post("/v1/packaging/generate-title").set(...AUTH_HEADER).send({});

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(mockPackagingService.generateTitle).not.toHaveBeenCalled();
  });

  it("accepts a videoProjectId alone (script resolved server-side) and returns the packagingId", async () => {
    // The documented persist contract (.claude/rules/api-design.md → the
    // /v1/packaging block): "persists → { titles, packagingId }". The fixture here
    // used to be `{ titles: [] }` — the PREVIEW shape — on the persist path, with
    // only a status assertion, so nothing in this suite proved the id the client
    // has to adopt ever leaves the server.
    mockPackagingService.generateTitle.mockResolvedValueOnce({ titles: TITLES, packagingId: "proj-1" });

    const res = await request(server())
      .post("/v1/packaging/generate-title")
      .set(...AUTH_HEADER)
      .send({ videoProjectId: "proj-1" });

    expect(res.status).toBe(200);
    expect(mockPackagingService.generateTitle).toHaveBeenCalledWith(
      testOwner("user-1"), undefined, "proj-1");
    expect(res.body.data).toEqual({ titles: TITLES, packagingId: "proj-1" });
  });
});

// ---------------------------------------------------------------------------
// POST /v1/packaging/generate-description | generate-thumbnail — both
// require `title`, both degrade to a 400 on the same shape.
// ---------------------------------------------------------------------------

describe.each([
  ["generate-description", "generateDescription", { description: "A long SEO description." }],
  ["generate-thumbnail", "generateThumbnail", { descriptions: ["Brief one", "Brief two"] }],
] as const)("POST /v1/packaging/%s", (path, serviceMethod, successPayload) => {
  it("returns the generated content, under the key the route documents", async () => {
    (mockPackagingService[serviceMethod] as jest.Mock).mockResolvedValueOnce(successPayload);

    const res = await request(server())
      .post(`/v1/packaging/${path}`)
      .set(...AUTH_HEADER)
      .send({ script: "s", title: "My Title" });

    expect(res.status).toBe(200);
    // `expect(res.body.success).toBe(true)` was true for ANY body, including one
    // where the controller forwarded nothing. The key names are the contract:
    // description → `description`, thumbnail → `descriptions` (plural, the briefs).
    expect(res.body.data).toEqual(successPayload);
  });

  it("returns the packagingId as well when the generation was persisted", async () => {
    (mockPackagingService[serviceMethod] as jest.Mock).mockResolvedValueOnce({
      ...successPayload,
      packagingId: "proj-1",
    });

    const res = await request(server())
      .post(`/v1/packaging/${path}`)
      .set(...AUTH_HEADER)
      .send({ script: "s", title: "My Title", videoProjectId: "proj-1" });

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ ...successPayload, packagingId: "proj-1" });
  });

  it("returns 400 when title is missing", async () => {
    const res = await request(server())
      .post(`/v1/packaging/${path}`)
      .set(...AUTH_HEADER)
      .send({ script: "s" });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(mockPackagingService[serviceMethod]).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// POST /v1/packaging/generate-shorts
// ---------------------------------------------------------------------------

describe("POST /v1/packaging/generate-shorts", () => {
  it("returns the segments, the total duration and (when persisted) the packagingId", async () => {
    const segments = [{ startTime: "0:00", endTime: "0:15", type: "hook", content: "Watch this" }];
    mockPackagingService.generateShorts.mockResolvedValueOnce({
      segments,
      totalDuration: "1:00",
      packagingId: "proj-1",
    });

    const res = await request(server())
      .post("/v1/packaging/generate-shorts")
      .set(...AUTH_HEADER)
      .send({ script: "s", duration: 60, videoProjectId: "proj-1" });

    expect(res.status).toBe(200);
    // Documented as "persists → { segments, totalDuration, packagingId }". A bare
    // `success: true` held even for an empty segment list — a Shorts script with
    // no script in it.
    expect(res.body.data).toEqual({ segments, totalDuration: "1:00", packagingId: "proj-1" });
  });

  it("returns 400 when duration is missing", async () => {
    const res = await request(server())
      .post("/v1/packaging/generate-shorts")
      .set(...AUTH_HEADER)
      .send({ script: "s" });

    expect(res.status).toBe(400);
    expect(mockPackagingService.generateShorts).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// POST /v1/packaging/save — packagingSaveSchema key-allowlisting.
// ---------------------------------------------------------------------------

describe("POST /v1/packaging/save", () => {
  it("returns the saved document, keyed on the project it belongs to", async () => {
    // The packaging doc id IS the video project id (firestore-conventions.md), so
    // these two agreeing is the invariant a reader depends on for its point read.
    mockPackagingService.savePackaging.mockResolvedValueOnce({
      id: "proj-1",
      videoProjectId: "proj-1",
      titles: TITLES,
      createdBy: "user-1",
      accountId: TEST_ACCOUNT_ID,
    });

    const res = await request(server())
      .post("/v1/packaging/save")
      .set(...AUTH_HEADER)
      .send({ videoProjectId: "proj-1", titles: TITLES });

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ id: "proj-1", videoProjectId: "proj-1", titles: TITLES });
  });

  it("hands back the project a door save created, so repeat saves cannot mint duplicates", async () => {
    // .claude/rules/api-design.md: "A door save without videoProjectId creates ONE
    // project and returns it on the saved doc; the client MUST adopt that id or
    // repeat saves mint duplicates." The old fixture returned `{ id: "pkg-1" }` —
    // no videoProjectId at all — so the one field that prevents a duplicate
    // project per keystroke was absent from both the fixture and the assertion.
    mockPackagingService.savePackaging.mockResolvedValueOnce({
      id: "proj-new",
      videoProjectId: "proj-new",
      description: "d",
    });

    const res = await request(server())
      .post("/v1/packaging/save")
      .set(...AUTH_HEADER)
      .send({ description: "d" });

    expect(res.status).toBe(200);
    expect(mockPackagingService.savePackaging).toHaveBeenCalledWith(
      testOwner("user-1"), { description: "d" }, undefined);
    expect(res.body.data.videoProjectId).toBe("proj-new");
  });

  // The highest-value case for this route: packagingSaveSchema must strip
  // isStale/itemStatuses/createdBy/accountId/script/hooks before the
  // service is ever called, so a client can never defeat the stale cascade
  // or rewrite ownership/generation-derived fields through an "edit" call.
  it("strips isStale, itemStatuses, createdBy, accountId, script and hooks from the body", async () => {
    mockPackagingService.savePackaging.mockResolvedValueOnce({ id: "pkg-1" });

    await request(server())
      .post("/v1/packaging/save")
      .set(...AUTH_HEADER)
      .send({
        videoProjectId: "proj-1",
        titles: [{ title: "T", characterCount: 1 }],
        isStale: true,
        staleReason: "manual",
        itemStatuses: { title: "completed" },
        createdBy: "attacker-uid",
        accountId: "acct-x",
        script: "sneaky full script",
        hooks: ["sneaky hook"],
      });

    expect(mockPackagingService.savePackaging).toHaveBeenCalledTimes(1);
    const [userIdArg, restArg, videoProjectIdArg] = mockPackagingService.savePackaging.mock.calls[0];
    expect(userIdArg).toEqual(testOwner("user-1"));
    expect(videoProjectIdArg).toBe("proj-1");
    expect(restArg).toHaveProperty("titles");
    for (const forbidden of ["isStale", "staleReason", "itemStatuses", "createdBy", "accountId", "script", "hooks"]) {
      expect(restArg).not.toHaveProperty(forbidden);
    }
  });

  it("uses the authenticated uid, ignoring a client-supplied createdBy/userId", async () => {
    mockPackagingService.savePackaging.mockResolvedValueOnce({ id: "pkg-1" });

    await request(server())
      .post("/v1/packaging/save")
      .set(...AUTH_HEADER)
      .send({ description: "d", createdBy: "attacker-uid", accountId: OTHER_ACCOUNT_ID });

    expect(mockPackagingService.savePackaging).toHaveBeenCalledWith(
      testOwner("user-1"), expect.anything(), undefined);
  });

  it("returns 404 when videoProjectId is provided but the project does not exist", async () => {
    mockPackagingService.savePackaging.mockRejectedValueOnce(NotFound("Video project not found"));

    const res = await request(server())
      .post("/v1/packaging/save")
      .set(...AUTH_HEADER)
      .send({ videoProjectId: "missing", description: "d" });

    expect(res.status).toBe(404);
  });

  it("refuses a save aimed at another channel's project, and says which kind of refusal", async () => {
    // HARM PREVENTED: an editor saving into a project that belongs to a channel
    // they are not in must be ejected (account_forbidden); the same save aimed at
    // their OWN other channel must offer a switch. One status cannot say both, and
    // a bare `Error` carrying `statusCode: 403` — which is what this fixture was —
    // is not a shape `forbidCrossAccount` can produce.
    mockPackagingService.savePackaging.mockRejectedValueOnce(AccountForbidden());

    const res = await request(server())
      .post("/v1/packaging/save")
      .set(...AUTH_HEADER)
      .send({ videoProjectId: "a-strangers-project", description: "d" });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("account_forbidden");
  });
});

// ---------------------------------------------------------------------------
// GET /v1/packaging/list
// ---------------------------------------------------------------------------

describe("GET /v1/packaging/list", () => {
  it("returns the ACTIVE CHANNEL's packages, each identified by its project", async () => {
    mockPackagingService.getPackagingByAccount.mockResolvedValueOnce([
      { id: "proj-1", videoProjectId: "proj-1", accountId: TEST_ACCOUNT_ID, titles: TITLES },
      { id: "proj-2", videoProjectId: "proj-2", accountId: TEST_ACCOUNT_ID, description: "d" },
    ]);

    const res = await request(server()).get("/v1/packaging/list").set(...AUTH_HEADER);

    expect(res.status).toBe(200);
    // `expect.any(Array)` passed on `[]`, i.e. on a list scoped to the wrong
    // channel returning nothing — which is exactly how a mis-scoped query looks.
    expect(res.body.data).toHaveLength(2);
    expect(res.body.data.map((pkg: { id: string }) => pkg.id)).toEqual(["proj-1", "proj-2"]);
    // Account-scoped, not per-user (api-design.md — the pre-Phase-06 framing).
    expect(mockPackagingService.getPackagingByAccount).toHaveBeenCalledWith(testOwner("user-1"));
  });
});

// ---------------------------------------------------------------------------
// GET /v1/packaging/:packagingId
// ---------------------------------------------------------------------------

describe("GET /v1/packaging/:packagingId", () => {
  it("returns the package's content and per-item statuses", async () => {
    mockPackagingService.getPackaging.mockResolvedValueOnce({
      id: "proj-1",
      videoProjectId: "proj-1",
      createdBy: "user-1",
      accountId: TEST_ACCOUNT_ID,
      titles: TITLES,
      description: "A long SEO description.",
      selectedTitleIndex: 1,
      itemStatuses: { title: "completed", description: "completed", thumbnail: "stale", shorts: "not_started" },
      isStale: true,
      staleReason: "hooks_regenerated",
    });

    const res = await request(server()).get("/v1/packaging/proj-1").set(...AUTH_HEADER);

    expect(res.status).toBe(200);
    // `itemStatuses` and the stale flags drive the amber "needs update" banner and
    // which regenerate buttons the screen offers; `selectedTitleIndex` is which
    // title is marked chosen. `expect.any(Object)` asserted none of it.
    expect(res.body.data).toMatchObject({
      id: "proj-1",
      titles: TITLES,
      selectedTitleIndex: 1,
      itemStatuses: { title: "completed", thumbnail: "stale", shorts: "not_started" },
      isStale: true,
      staleReason: "hooks_regenerated",
    });
  });

  // 404 and 403 are DIFFERENT cases here, and this block used to conflate them:
  // it asserted 404 under the title "another user's document", with a comment
  // claiming the service resolves null for both. It does not —
  // `PackagingService.getPackaging` returns null only when the doc is missing, and
  // hands a cross-channel document to `forbidCrossAccount`, which always throws a
  // CODED 403. Because the service is mocked here, the test happily proved the
  // controller forwards whatever the mock was told to produce, and the mock had
  // been told the wrong thing.
  it("returns 404 when the document does not exist", async () => {
    mockPackagingService.getPackaging.mockResolvedValueOnce(null);

    const res = await request(server()).get("/v1/packaging/missing-pkg").set(...AUTH_HEADER);

    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
  });

  // `Forbidden()` — the bare factory this used to throw — carries NO code, and no
  // service in src/ throws it any more: every cross-channel check goes through
  // `forbidCrossAccount`, which throws one of the two coded 403s. So the old
  // fixture was unreachable, and with only a status assertion the discriminator
  // that decides between "eject" and "offer a switch" was untested on this route.
  it("returns 403 with wrong_account, and names the channel, for a package in the caller's other channel", async () => {
    // HARM PREVENTED: this is the bookmarked-link request. Without the code and
    // detail the screen says "Project not found. It may have been deleted." about
    // a package sitting one switch away.
    mockPackagingService.getPackaging.mockRejectedValueOnce(
      WrongAccount({ accountId: OTHER_ACCOUNT_ID, displayName: "Finance Channel" })
    );

    const res = await request(server()).get("/v1/packaging/pkg-in-my-other-channel").set(...AUTH_HEADER);

    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
    expect(res.body.code).toBe("wrong_account");
    expect(res.body.detail).toMatchObject({ accountId: OTHER_ACCOUNT_ID, displayName: "Finance Channel" });
  });

  it("returns 403 with account_forbidden, disclosing nothing, for a stranger's package", async () => {
    mockPackagingService.getPackaging.mockRejectedValueOnce(AccountForbidden());

    const res = await request(server()).get("/v1/packaging/a-strangers-pkg").set(...AUTH_HEADER);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("account_forbidden");
    expect(res.body.detail).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain(OTHER_ACCOUNT_ID);
  });
});

// ---------------------------------------------------------------------------
// POST /v1/packaging/:packagingId/regenerate/:item
// ---------------------------------------------------------------------------

describe("POST /v1/packaging/:packagingId/regenerate/:item", () => {
  it("returns the regenerated item in its canonical shape, named", async () => {
    mockPackagingService.regenerateItem.mockResolvedValueOnce({
      id: "proj-1",
      item: "title",
      data: TITLES,
    });

    const res = await request(server())
      .post("/v1/packaging/proj-1/regenerate/title")
      .set(...AUTH_HEADER)
      .send({ script: "s" });

    expect(res.status).toBe(200);
    // The service normalizes once and returns the CANONICAL shape so this response
    // matches what a later GET or export returns; asserting only `item: "title"`
    // left the payload itself — the whole point of the call — unchecked.
    expect(res.body.data).toEqual({ id: "proj-1", item: "title", data: TITLES });
  });

  // Owning-ID rule: regenerate operates on an EXISTING packagingId; the
  // stored document's videoProjectId is used server-side, so a body-supplied
  // one must never reach the service call.
  it("ignores a body-supplied videoProjectId on regenerate", async () => {
    mockPackagingService.regenerateItem.mockResolvedValueOnce({ id: "pkg-1", item: "title", data: [] });

    await request(server())
      .post("/v1/packaging/pkg-1/regenerate/title")
      .set(...AUTH_HEADER)
      .send({ script: "s", videoProjectId: "attacker-chosen-project" });

    expect(mockPackagingService.regenerateItem).toHaveBeenCalledWith(
      testOwner("user-1"),
      "pkg-1",
      "title",
      "s",
      undefined,
      undefined
    );
  });

  it("returns 404 when the packaging document does not exist", async () => {
    mockPackagingService.regenerateItem.mockRejectedValueOnce(NotFound("Packaging not found"));

    const res = await request(server())
      .post("/v1/packaging/missing-pkg/regenerate/title")
      .set(...AUTH_HEADER)
      .send({ script: "s" });

    expect(res.status).toBe(404);
  });

  it("refuses a regenerate on another channel's package, with the reason attached", async () => {
    mockPackagingService.regenerateItem.mockRejectedValueOnce(
      WrongAccount({ accountId: OTHER_ACCOUNT_ID, displayName: "Finance Channel" })
    );

    const res = await request(server())
      .post("/v1/packaging/pkg-in-my-other-channel/regenerate/title")
      .set(...AUTH_HEADER)
      .send({ script: "s" });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("wrong_account");
    expect(res.body.detail).toMatchObject({ accountId: OTHER_ACCOUNT_ID });
  });
});

// ---------------------------------------------------------------------------
// POST /v1/packaging/:packagingId/select-title
// ---------------------------------------------------------------------------

describe("POST /v1/packaging/:packagingId/select-title", () => {
  it("returns the chosen index AND the title text it promoted to the project name", async () => {
    // `selectTitle` returns `{ id, selectedTitleIndex, title }` — the `title` is
    // the video project's new display name, which the header and the dashboard
    // both render from this response. The fixture omitted it and the assertion was
    // `expect.any(Object)`, so a controller that dropped it would have passed
    // while the project silently kept its placeholder working title on screen.
    mockPackagingService.selectTitle.mockResolvedValueOnce({
      id: "proj-1",
      selectedTitleIndex: 1,
      title: TITLES[1].title,
    });

    const res = await request(server())
      .post("/v1/packaging/proj-1/select-title")
      .set(...AUTH_HEADER)
      .send({ index: 1 });

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ id: "proj-1", selectedTitleIndex: 1, title: TITLES[1].title });
  });

  it("returns 400 when index is missing", async () => {
    const res = await request(server()).post("/v1/packaging/pkg-1/select-title").set(...AUTH_HEADER).send({});

    expect(res.status).toBe(400);
    expect(mockPackagingService.selectTitle).not.toHaveBeenCalled();
  });

  it("returns 400 when index is not a number", async () => {
    const res = await request(server())
      .post("/v1/packaging/pkg-1/select-title")
      .set(...AUTH_HEADER)
      .send({ index: "1" });

    expect(res.status).toBe(400);
    expect(mockPackagingService.selectTitle).not.toHaveBeenCalled();
  });

  it("returns 404 when the packaging document does not exist", async () => {
    mockPackagingService.selectTitle.mockRejectedValueOnce(NotFound("Packaging not found"));

    const res = await request(server())
      .post("/v1/packaging/missing-pkg/select-title")
      .set(...AUTH_HEADER)
      .send({ index: 0 });

    expect(res.status).toBe(404);
  });

  it("refuses select-title on a stranger's package with account_forbidden", async () => {
    mockPackagingService.selectTitle.mockRejectedValueOnce(AccountForbidden());

    const res = await request(server())
      .post("/v1/packaging/a-strangers-pkg/select-title")
      .set(...AUTH_HEADER)
      .send({ index: 0 });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("account_forbidden");
  });
});

// ---------------------------------------------------------------------------
// GET /v1/packaging/:packagingId/export
// ---------------------------------------------------------------------------

describe("GET /v1/packaging/:packagingId/export", () => {
  it("returns 200 with exported text", async () => {
    mockPackagingService.exportPackaging.mockResolvedValueOnce({
      text: `Video Package\n\nTITLES\n1. ${TITLES[0].title}\n2. ${TITLES[1].title}  \u2190 selected`,
    });

    const res = await request(server()).get("/v1/packaging/proj-1/export").set(...AUTH_HEADER);

    expect(res.status).toBe(200);
    // The export is what the creator pastes into YouTube, so it has to SAY which
    // variation they chose — `expect.any(String)` was satisfied by "".
    expect(res.body.data.text).toContain(TITLES[1].title);
    expect(res.body.data.text).toContain("selected");
  });

  it("returns 404 when the packaging document does not exist", async () => {
    mockPackagingService.exportPackaging.mockRejectedValueOnce(NotFound("Packaging not found"));

    const res = await request(server()).get("/v1/packaging/missing-pkg/export").set(...AUTH_HEADER);

    expect(res.status).toBe(404);
  });

  it("refuses an export of another channel's package, and offers the switch", async () => {
    mockPackagingService.exportPackaging.mockRejectedValueOnce(
      WrongAccount({ accountId: OTHER_ACCOUNT_ID, displayName: "Finance Channel" })
    );

    const res = await request(server()).get("/v1/packaging/pkg-in-my-other-channel/export").set(...AUTH_HEADER);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("wrong_account");
    expect(res.body.detail).toMatchObject({ accountId: OTHER_ACCOUNT_ID, displayName: "Finance Channel" });
  });
});

// ---------------------------------------------------------------------------
// Auth — router-wide via router.use(authMiddleware). The documented-403-vs-
// actual-401 status code mismatch is flagged once (with a `test.failing`) in
// ideas.route.behaviour.test.ts; not repeated here.
// ---------------------------------------------------------------------------

describe("Auth", () => {
  it("rejects a request with no Authorization header without reaching the service", async () => {
    const res = await request(server()).get("/v1/packaging/list");

    expect(res.status).not.toBe(200);
    expect(res.body.success).toBe(false);
    expect(mockPackagingService.getPackagingByAccount).not.toHaveBeenCalled();
  });

  it("rejects a request with an invalid token without reaching the service", async () => {
    mockVerifyIdToken.mockRejectedValueOnce(new Error("invalid token"));

    const res = await request(server()).get("/v1/packaging/list").set("Authorization", "Bearer bad-token");

    expect(res.status).not.toBe(200);
    expect(res.body.success).toBe(false);
    expect(mockPackagingService.getPackagingByAccount).not.toHaveBeenCalled();
  });
});
