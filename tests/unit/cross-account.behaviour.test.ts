/**
 * Phase 06's reason for existing: one channel's data must never reach another.
 *
 * Run against a Firestore fake that actually applies `where` (see
 * `tests/helpers/fake-firestore.ts`), because the chain mocks used everywhere
 * else cannot see a query filtering the wrong field — they return the queued rows
 * no matter what was asked for. Query scoping is exactly half of this phase.
 *
 * THE FIXTURE THAT HAS TEETH is `uidOwner` owning BOTH channels. Two different
 * users isolating correctly proves much less than it looks: a query that filtered
 * on the right *user* and the wrong *account* would still separate them perfectly.
 * The interesting bug only shows when one person has two channels, so every
 * listing assertion below acts as that person and demands one channel's rows.
 *
 * The mirror case matters just as much and is easy to forget: a co-member acting
 * in a channel they did NOT author a document in must be ALLOWED. Ownership moved
 * from the person to the channel, and a check left on `createdBy` still passes
 * every isolation test while quietly breaking sharing in Phase 09.
 */

jest.mock("../../src/config/firebase", () =>
  require("../helpers/fake-firestore").mockFirebase()
);

// Nothing here may reach a model. Every assertion below is that a request is
// refused BEFORE generating, so arriving at the model is itself the failure —
// and left unmocked it is a very confusing one: the suite makes a real network
// call, fails on an API key, and reports a 400 where a 403 was expected. It also
// caught a positional-argument slip in this file's own fixtures, which is worth
// keeping loud.
jest.mock("../../src/utlils/ai", () => ({
  generateStreamingContent: jest.fn(async () => {
    throw new Error(
      "reached the model — an ownership check did not run before generating"
    );
  }),
  collectJson: jest.fn(),
}));

import { fakeAccountRepo } from "../helpers/account";
import { FakeFirestore } from "../helpers/fake-firestore";
import ContentRepository from "../../src/repository/content.repository";
import VideoProjectRepository from "../../src/repository/video-project.repository";
import PackagingRepository from "../../src/repository/packaging.repository";
import HooksRepository from "../../src/repository/hooks.repository";
import UserRepository from "../../src/repository/user.repository";
import VideoProjectService from "../../src/service/video-project.service";
import ContextService from "../../src/service/context.service";
import ContentService from "../../src/service/content.service";
import PackagingService from "../../src/service/packaging.service";
import HooksService from "../../src/service/hooks.service";

const db = (require("../../src/config/firebase") as { __db: FakeFirestore }).__db;

const ACC_A = "acc-aaaaaaaa-1111-4111-8111-111111111111";
const ACC_B = "acc-bbbbbbbb-2222-4222-8222-222222222222";

// One person, two channels — a cooking channel and a finance channel.
const uidOwner = "uid-owner";
// A second member of channel A only. Sharing is Phase 09; this fixture is what
// proves the permission field is the ACCOUNT before that lands.
const uidMate = "uid-mate";

const inA = { userId: uidOwner, accountId: ACC_A };
const inB = { userId: uidOwner, accountId: ACC_B };
const mateInA = { userId: uidMate, accountId: ACC_A };

/** A stored timestamp, which the repositories call `.toDate()` on. */
const ts = (millis: number) => ({
  toDate: () => new Date(millis),
  toMillis: () => millis,
});

beforeEach(() => {
  db.data.clear();

  // `ContextService.assemble` reads the user record for channel context in the
  // same Promise.all as the project lookup, so without these the generation paths
  // reject with 404 "User not found" before the tenancy check can be observed.
  db.seed("users", [
    { id: uidOwner, niche: "cooking", targetAudience: "home cooks", lastActiveAccountId: ACC_A },
    { id: uidMate, niche: "cooking", targetAudience: "home cooks", lastActiveAccountId: ACC_A },
  ]);

  db.seed("ideas", [
    { id: "idea-a", title: "Cooking idea", createdBy: uidOwner, accountId: ACC_A, archived: false, createdAt: ts(1000) },
    { id: "idea-b", title: "Finance idea", createdBy: uidOwner, accountId: ACC_B, archived: false, createdAt: ts(2000) },
    // Authored by the co-member, but it belongs to channel A.
    { id: "idea-a2", title: "Mate's idea", createdBy: uidMate, accountId: ACC_A, archived: false, createdAt: ts(3000) },
  ]);

  db.seed("scripts", [
    { id: "script-a", title: "A", script: "aaa", createdBy: uidOwner, accountId: ACC_A, createdAt: ts(1000) },
    { id: "script-b", title: "B", script: "bbb", createdBy: uidOwner, accountId: ACC_B, createdAt: ts(2000) },
  ]);

  db.seed("videoProjects", [
    { id: "proj-a", title: "A", ideaId: "idea-a", scriptId: "script-a", createdBy: uidOwner, accountId: ACC_A, isDeleted: false, overallStatus: "in_progress", updatedAt: ts(1000), pipeline: {} },
    { id: "proj-b", title: "B", ideaId: "idea-b", scriptId: "script-b", createdBy: uidOwner, accountId: ACC_B, isDeleted: false, overallStatus: "in_progress", updatedAt: ts(2000), pipeline: {} },
  ]);

  db.seed("packaging", [
    { id: "proj-a", videoProjectId: "proj-a", createdBy: uidOwner, accountId: ACC_A, createdAt: ts(1000) },
    { id: "proj-b", videoProjectId: "proj-b", createdBy: uidOwner, accountId: ACC_B, createdAt: ts(2000) },
  ]);

  db.seed("hooks", [
    { id: "hooks-a", videoProjectId: "proj-a", createdBy: uidOwner, accountId: ACC_A, hooks: ["h"], hookFeedback: {} },
    { id: "hooks-b", videoProjectId: "proj-b", createdBy: uidOwner, accountId: ACC_B, hooks: ["h"], hookFeedback: {} },
  ]);
});

const ids = (rows: { id?: unknown }[]) => rows.map((r) => String(r.id)).sort();

// Real repositories over the fake store, so a check that reads the wrong field
// fails here rather than passing against a stub that never looked.
const wire = () => {
  const contentRepo = new ContentRepository();
  const projectRepo = new VideoProjectRepository();
  const packagingRepo = new PackagingRepository();
  const hooksRepo = new HooksRepository();
  const userRepo = new UserRepository();
  const projects = new VideoProjectService(contentRepo && projectRepo, contentRepo, packagingRepo, hooksRepo);
  const context = new ContextService(fakeAccountRepo(), contentRepo, hooksRepo, projects);
  return {
    projects,
    context,
    content: new ContentService(contentRepo, userRepo, projects, fakeAccountRepo()),
    packaging: new PackagingService(packagingRepo, projects, context),
    hooks: new HooksService(hooksRepo, projects, context, {
      run: async (_s: unknown, g: () => unknown) => g(),
    } as never),
  };
};

const forbidden = { statusCode: 403 };

describe("listing one channel never returns the same user's other channel", () => {
  const content = () => new ContentRepository();
  const projects = () => new VideoProjectRepository();

  it("ideas", async () => {
    const rows = await content().getIdeas({
      accountId: ACC_A,
      limit: 10,
      cursor: { createdAt: "", docId: "" },
      filters: {},
    });

    expect(ids(rows)).toEqual(["idea-a", "idea-a2"]);
  });

  it("ideas — the active batch used by regenerate and export", async () => {
    expect(ids(await content().getActiveBatch(ACC_B))).toEqual(["idea-b"]);
  });

  it("ideas — the clustering pool that seeds 'avoid repeating yourself'", async () => {
    // The bug this phase's own doc names: scoped to the USER, the cooking
    // channel's ideas would suppress the finance channel's.
    const pool = await content().getIdeasForClustering(ACC_B);

    expect(pool.map((p) => p.title)).toEqual(["Finance idea"]);
  });

  it("scripts", async () => {
    expect(ids(await content().getScripts(ACC_A))).toEqual(["script-a"]);
  });

  it("video projects", async () => {
    const { projects: rows } = await projects().list(ACC_A, { limit: 10 });
    expect(ids(rows)).toEqual(["proj-a"]);
  });

  it("packaging", async () => {
    expect(ids(await new PackagingRepository().getByAccountId(ACC_B))).toEqual(["proj-b"]);
  });

  it("projects located by their idea", async () => {
    // Scoped by account, so channel B's project is unreachable from channel A
    // even holding its idea id.
    expect(await projects().findByIdeaId("idea-b", ACC_A)).toEqual([]);
    expect(ids(await projects().findByIdeaId("idea-b", ACC_B))).toEqual(["proj-b"]);
  });

  it("archiving a channel's batch leaves the other channel untouched", async () => {
    // The only DESTRUCTIVE query in the set. Mis-scoped, "Regenerate All" in one
    // channel silently archives the other channel's ideas — they stop appearing
    // in every list, with no error and nothing deleted to notice.
    await new ContentRepository().archiveUserIdeas(ACC_A);

    const archived = Object.fromEntries(
      db.all("ideas").map((i) => [String(i.id), i.archived])
    );
    expect(archived).toEqual({ "idea-a": true, "idea-a2": true, "idea-b": false });
  });

  it("projects located by their script", async () => {
    expect(await projects().findByScriptId("script-b", ACC_A)).toBeNull();
    expect(await projects().findByScriptId("script-b", ACC_B)).not.toBeNull();
  });
});

describe("reaching another channel's document by id is refused", () => {
  const vpService = () =>
    new VideoProjectService(
      new VideoProjectRepository(),
      new ContentRepository(),
      new PackagingRepository(),
      new HooksRepository()
    );

  it("a project", async () => {
    await expect(vpService().getById("proj-b", inA)).rejects.toMatchObject(forbidden);
  });

  it("a project, on delete", async () => {
    await expect(vpService().delete("proj-b", inA)).rejects.toMatchObject({ statusCode: 403 });
    // And it stayed alive.
    expect(db.all("videoProjects").find((p) => p.id === "proj-b")!.isDeleted).toBe(false);
  });

  it("a project, on rename", async () => {
    await expect(
      vpService().update("proj-b", inA, { title: "renamed" })
    ).rejects.toMatchObject(forbidden);

    expect(db.all("videoProjects").find((p) => p.id === "proj-b")!.title).toBe("B");
  });

  it("a project, on a pipeline step transition", async () => {
    await expect(vpService().completeStep("proj-b", "hooks", inA)).rejects.toMatchObject({
      statusCode: 403,
    });
  });

  it("a hooks batch", async () => {
    const hooks = new HooksService(
      new HooksRepository(),
      vpService(),
      undefined,
      { run: async (_s: unknown, g: () => unknown) => g() } as never
    );

    await expect(hooks.getById(inA, "hooks-b")).rejects.toMatchObject({ statusCode: 403 });
    await expect(hooks.exportHooks(inA, "hooks-b")).rejects.toMatchObject({ statusCode: 403 });
    await expect(hooks.select(inA, "hooks-b", 0)).rejects.toMatchObject({ statusCode: 403 });
  });

  // The body-supplied-id case the route list alone misses: the project is yours,
  // the resource id is not.
  it("a foreign resource id linked onto a project you do own", async () => {
    await expect(
      vpService().linkResource("proj-a", "hooks", "hooks-b", inA)
    ).rejects.toMatchObject({ statusCode: 403 });

    expect(db.all("videoProjects").find((p) => p.id === "proj-a")!.hooksId).toBeUndefined();
  });

  it("a foreign idea used to create a project", async () => {
    await expect(vpService().create(inA, "idea-b")).rejects.toMatchObject({ statusCode: 403 });
  });
});

describe("a co-member of the channel is allowed, even on documents they did not author", () => {
  // The mirror of every test above, and the one a check left on `createdBy`
  // fails. It passes today by construction — nothing creates a second member
  // until Phase 09 — which is exactly why it has to be asserted now, while the
  // rewrite is fresh, rather than discovered when sharing ships.
  const vpService = () =>
    new VideoProjectService(
      new VideoProjectRepository(),
      new ContentRepository(),
      new PackagingRepository(),
      new HooksRepository()
    );

  it("reads a project authored by someone else in the same channel", async () => {
    const project = await vpService().getById("proj-a", mateInA);
    expect(project.id).toBe("proj-a");
  });

  it("sees the whole channel's ideas, not only their own", async () => {
    const rows = await new ContentRepository().getIdeas({
      accountId: ACC_A,
      limit: 10,
      cursor: { createdAt: "", docId: "" },
      filters: {},
    });

    // Both authors, one channel.
    expect(ids(rows)).toEqual(["idea-a", "idea-a2"]);
  });

  it("is still refused in a channel they are not a member of", async () => {
    // Membership itself is accountMiddleware's job — this asserts the layer below
    // agrees: the account on the request is the only thing that decides.
    await expect(
      vpService().getById("proj-b", { userId: uidMate, accountId: ACC_A })
    ).rejects.toMatchObject({ statusCode: 403 });
  });
});

describe("the account is what decides, not the author", () => {
  it("refuses the AUTHOR of a document when they are acting in another channel", async () => {
    // `uidOwner` wrote proj-b. Acting in channel A they cannot touch it. A check
    // comparing `createdBy` to the uid would let this through, and no isolation
    // test built from two different users would ever notice.
    const service = new VideoProjectService(
      new VideoProjectRepository(),
      new ContentRepository(),
      new PackagingRepository(),
      new HooksRepository()
    );

    await expect(service.getById("proj-b", inA)).rejects.toMatchObject({ statusCode: 403 });
    await expect(service.getById("proj-b", inB)).resolves.toMatchObject({ id: "proj-b" });
  });

  it("refuses a step lock taken from the wrong channel, inside the transaction", async () => {
    // acquireStep re-checks ownership inside its own transaction, because a check
    // performed outside it guarantees nothing about the write.
    const repo = new VideoProjectRepository();

    await expect(
      repo.acquireStep("proj-b", "hooks", inA, { requires: [], lockMs: 1000 })
    ).rejects.toMatchObject({ statusCode: 403 });
  });
});

describe("scripts and ideas — every id-addressed content route", () => {
  // These reach the ownership check before any model call, so a foreign id is
  // refused without spending a generation. That ordering is the point: a check
  // after the call still leaks the answer and still costs a credit in Phase 08.
  it("refuses reading, editing, exporting and regenerating another channel's script", async () => {
    const { content } = wire();

    await expect(content.getScriptById("script-b", inA)).rejects.toMatchObject(forbidden);
    await expect(content.editScript("script-b", inA, { script: "x" })).rejects.toMatchObject(forbidden);
    await expect(content.exportScript(inA, "script-b")).rejects.toMatchObject(forbidden);
    await expect(content.regenerateScript(inA, "script-b")).rejects.toMatchObject(forbidden);

    // And nothing was written on the way to refusing.
    expect(db.all("scripts").find((r) => r.id === "script-b")!.script).toBe("bbb");
  });

  it("refuses editing and regenerating another channel's idea", async () => {
    const { content } = wire();

    await expect(content.editIdeas("idea-b", inA, { title: "stolen" })).rejects.toMatchObject(forbidden);
    await expect(content.regenerateOne(inA, "idea-b")).rejects.toMatchObject(forbidden);

    expect(db.all("ideas").find((r) => r.id === "idea-b")!.title).toBe("Finance idea");
  });

  it("lets a co-member edit an idea they did not author", async () => {
    const { content } = wire();

    await content.editIdeas("idea-a", mateInA, { title: "renamed by mate" });

    expect(db.all("ideas").find((r) => r.id === "idea-a")!.title).toBe("renamed by mate");
  });
});

describe("packaging — every id-addressed route", () => {
  it("refuses reading, exporting, selecting a title on and regenerating another channel's package", async () => {
    const { packaging } = wire();

    await expect(packaging.getPackaging("proj-b", inA)).rejects.toMatchObject(forbidden);
    await expect(packaging.exportPackaging(inA, "proj-b")).rejects.toMatchObject(forbidden);
    await expect(packaging.selectTitle(inA, "proj-b", 0)).rejects.toMatchObject(forbidden);
    await expect(packaging.regenerateItem(inA, "proj-b", "description")).rejects.toMatchObject(forbidden);
  });

  it("lets a co-member read a package they did not author", async () => {
    const { packaging } = wire();

    await expect(packaging.getPackaging("proj-a", mateInA)).resolves.toMatchObject({ id: "proj-a" });
  });
});

describe("a foreign owning id in the BODY is refused before anything generates", () => {
  // The routes the id-addressed list above misses entirely: the document being
  // written does not exist yet, so the only thing to check is the id the client
  // sent. Every one of these resolves the project first, and the project is what
  // carries the account.
  it("packaging generate-* pointed at another channel's project", async () => {
    const { packaging } = wire();

    // Note the argument order: description and thumbnail take (script, title,
    // videoProjectId). Passing the project id one slot early makes it the TITLE
    // and leaves videoProjectId undefined — the stateless-preview path, which
    // legitimately generates and never checks a project. All three are strings,
    // so nothing catches it; the first draft of this test did exactly that and
    // "failed" against the live API.
    await expect(packaging.generateTitle(inA, "a script", "proj-b")).rejects.toMatchObject(forbidden);
    await expect(
      packaging.generateDescription(inA, "a script", "A title", "proj-b")
    ).rejects.toMatchObject(forbidden);
    await expect(
      packaging.generateThumbnail(inA, "a script", "A title", "proj-b")
    ).rejects.toMatchObject(forbidden);
    await expect(
      packaging.generateShorts(inA, "a script", 60, "proj-b")
    ).rejects.toMatchObject(forbidden);

    // Nothing was persisted into the foreign project's package.
    expect(db.all("packaging").find((r) => r.id === "proj-b")).toEqual(
      expect.not.objectContaining({ titles: expect.anything() })
    );
  });

  it("hooks generate pointed at another channel's project", async () => {
    const { hooks } = wire();

    await expect(hooks.generate(inA, "proj-b", "a script")).rejects.toMatchObject(forbidden);
  });

  it("a script stream for another channel's project", async () => {
    // The SSE route's account comes from the PROJECT (resolveAccountFromProject),
    // so the membership check is the whole protection there and is tested in
    // tests/integration/account-middleware.behaviour.test.ts. This asserts the
    // layer below agrees: even reaching the service with a mismatched account is
    // refused, so the two checks cannot disagree.
    const { content } = wire();
    const res = { write: jest.fn(), end: jest.fn(), setHeader: jest.fn(), flushHeaders: jest.fn() };

    await expect(
      content.generateScripts(inA, "proj-b", res as never)
    ).rejects.toMatchObject(forbidden);
    expect(res.write).not.toHaveBeenCalled();
  });
});
