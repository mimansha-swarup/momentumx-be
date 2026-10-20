import { unmeteredSteps } from "../../helpers/step-runner";
// Paging through ideas — including the search case, which is a DIFFERENT ordering
// and therefore a different cursor.
//
// Only half of this was tested. The repository's side (given a cursor, build the
// right orderBy/startAfter) is covered in
// `tests/unit/repository/content.repository.behaviour.test.ts`. The service side —
// which DECIDES which cursor shape to emit — had no test anywhere, and every
// integration test mocks ContentService wholesale. Reverting the branch to always
// emit `{createdAt, docId}` would bring back the original bug (search paging stuck
// on page 1 forever, because the repository is handed a cursor it cannot apply and
// so applies none) without a single failure.

jest.mock("firebase-admin", () => ({
  apps: [],
  initializeApp: jest.fn(),
  credential: { cert: jest.fn() },
  firestore: Object.assign(jest.fn().mockReturnValue({}), {
    FieldValue: { serverTimestamp: jest.fn(), increment: jest.fn() },
    FieldPath: { documentId: jest.fn() },
  }),
  auth: jest.fn().mockReturnValue({ verifyIdToken: jest.fn() }),
}));

jest.mock("../../../src/config/firebase", () => ({
  db: {},
  auth: {},
  firebase: {
    firestore: {
      FieldValue: { serverTimestamp: jest.fn(), increment: jest.fn() },
      FieldPath: { documentId: jest.fn() },
    },
  },
}));

jest.mock("../../../src/config/ai", () => ({
  __esModule: true,
  default: jest.fn(),
  embeddingModel: { embedContent: jest.fn() },
}));

import ContentService from "../../../src/service/content.service";
import ContentRepository from "../../../src/repository/content.repository";
import UserRepository from "../../../src/repository/user.repository";
import { makeTestAccountService, testOwner, fakeAccountRepo } from "../../helpers/account";

jest.mock("../../../src/repository/content.repository");
jest.mock("../../../src/repository/user.repository");

const stamp = (iso: string) => ({ toDate: () => new Date(iso) });

const idea = (id: string, title: string, iso = "2026-08-01T10:00:00.000Z") => ({
  id,
  title,
  createdAt: stamp(iso),
  updatedAt: null,
});

const makeService = (docs: unknown[]) => {
  const repo = new (ContentRepository as jest.MockedClass<typeof ContentRepository>)() as jest.Mocked<ContentRepository>;
  // Honours `limit`, because the service now asks for one row MORE than the page
  // to decide `hasNextPage`. A stub that ignores the limit cannot tell the probe
  // apart from the page and would report whatever the fixture happened to hold.
  repo.getIdeas = jest.fn(async ({ limit }: { limit: number }) =>
    docs.slice(0, limit)
  ) as unknown as typeof repo.getIdeas;
  const userRepo = new (UserRepository as jest.MockedClass<typeof UserRepository>)() as jest.Mocked<UserRepository>;
  return { service: new ContentService(repo, userRepo, {} as never, fakeAccountRepo(), undefined, unmeteredSteps), repo };
};

describe("getPaginatedUsersIdeas — the cursor must match the ordering the page used", () => {
  it("emits a createdAt cursor for the default list", async () => {
    const { service } = makeService([
      idea("i-1", "First", "2026-08-01T10:00:00.000Z"),
      idea("i-2", "Second", "2026-07-30T09:00:00.000Z"),
    ]);

    const res = await service.getPaginatedUsersIdeas({
      userId: "user-1",
      limit: 9,
      cursor: { createdAt: "", title: "", docId: "" },
      filters: { searchText: "" },
    } as never);

    // The LAST doc on the page, not the first — the next page starts after it.
    expect(res.meta.nextCursor).toEqual({
      createdAt: "2026-07-30T09:00:00.000Z",
      docId: "i-2",
    });
  });

  it("emits a TITLE cursor for a search, because search orders by title", async () => {
    const { service } = makeService([idea("i-1", "Alpha"), idea("i-2", "Beta")]);

    const res = await service.getPaginatedUsersIdeas({
      userId: "user-1",
      limit: 9,
      cursor: { createdAt: "", title: "", docId: "" },
      filters: { searchText: "al" },
    } as never);

    expect(res.meta.nextCursor).toEqual({ title: "Beta", docId: "i-2" });
    // A createdAt cursor here is the original bug: the repository cannot apply it
    // to a title-ordered query, so it applies none and page 2 repeats page 1.
    expect(res.meta.nextCursor).not.toHaveProperty("createdAt");
  });

  it("carries docId in both shapes, so duplicate titles or timestamps cannot skip a record", async () => {
    const { service } = makeService([idea("i-1", "Same"), idea("i-2", "Same")]);

    const search = await service.getPaginatedUsersIdeas({
      userId: "user-1", limit: 9,
      cursor: { createdAt: "", title: "", docId: "" },
      filters: { searchText: "sa" },
    } as never);

    expect(search.meta.nextCursor).toMatchObject({ docId: "i-2" });
  });

  it("returns a null cursor on an empty page instead of a cursor pointing at nothing", async () => {
    const { service } = makeService([]);

    const res = await service.getPaginatedUsersIdeas({
      userId: "user-1", limit: 9,
      cursor: { createdAt: "", title: "", docId: "" },
      filters: { searchText: "" },
    } as never);

    expect(res.meta.nextCursor).toBeNull();
    expect(res.meta.hasNextPage).toBe(false);
  });

  /**
   * This asserted `hasNextPage === (limit === docs.length)`, which is a guess,
   * not an answer: a final page that happens to be exactly `limit` long looks
   * identical to a full page with more behind it. The client rendered "Load
   * more" and the next request came back empty. The service now asks the
   * repository for one row beyond the page and reports what it finds.
   */
  const page = (docs: unknown[], limit: number) =>
    makeService(docs).service.getPaginatedUsersIdeas({
      userId: "user-1", limit,
      cursor: { createdAt: "", title: "", docId: "" },
      filters: { searchText: "" },
    } as never);

  it("reports another page when one actually exists", async () => {
    const res = await page([idea("a", "A"), idea("b", "B"), idea("c", "C")], 2);

    expect(res.meta.hasNextPage).toBe(true);
    // And the probe row is not served to the client.
    expect(res.lists).toHaveLength(2);
    expect(res.lists.map((l) => (l as unknown as { id: string }).id)).toEqual(["a", "b"]);
  });

  it("reports no next page for a final page that is exactly full", async () => {
    // The case the old rule got wrong, and the only one a user notices.
    const res = await page([idea("a", "A"), idea("b", "B")], 2);

    expect(res.meta.hasNextPage).toBe(false);
    expect(res.lists).toHaveLength(2);
  });

  it("reports no next page for a partial page", async () => {
    const res = await page([idea("a", "A")], 2);

    expect(res.meta.hasNextPage).toBe(false);
  });

  it("emits a cursor from the last row OF THE PAGE, not from the probe row", async () => {
    // Emitting the probe's cursor would skip a record on every "Load more".
    const res = await page([idea("a", "A"), idea("b", "B"), idea("c", "C")], 2);

    expect(res.meta.nextCursor).toMatchObject({ docId: "b" });
  });

  it("serialises timestamps for the client rather than leaking raw Firestore objects", async () => {
    const { service } = makeService([idea("i-1", "First", "2026-08-01T10:00:00.000Z")]);

    const res = await service.getPaginatedUsersIdeas({
      userId: "user-1", limit: 9,
      cursor: { createdAt: "", title: "", docId: "" },
      filters: { searchText: "" },
    } as never);

    expect(res.lists[0].createdAt).toBe("2026-08-01T10:00:00.000Z");
  });
});
