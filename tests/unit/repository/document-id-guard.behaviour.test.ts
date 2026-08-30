/**
 * A client string reaching `.doc()` must not become a 500.
 *
 * `db.collection(c).doc(value)` splits `value` on "/" and treats it as a PATH.
 * An odd number of segments addresses a COLLECTION, and `.doc()` throws a plain
 * `Error` — no `statusCode`, so `error_handler` renders it as 500 "Something
 * went wrong". Every id-addressed route takes its id straight from `req.params`,
 * and Express percent-decodes, so `GET /v1/scripts/a%2Fb` was one request away.
 *
 * The honest answer is not-found, which is what each repository's own
 * missing-document branch already returns.
 */

const docFn = jest.fn(() => {
  throw new Error("Value for argument \"documentPath\" must point to a document");
});

jest.mock("../../../src/config/firebase", () => ({
  db: { collection: jest.fn(() => ({ doc: docFn })) },
  firebase: {
    firestore: {
      FieldValue: { serverTimestamp: jest.fn() },
      FieldPath: { documentId: jest.fn() },
    },
  },
}));

import ContentRepository from "../../../src/repository/content.repository";
import HooksRepository from "../../../src/repository/hooks.repository";
import PackagingRepository from "../../../src/repository/packaging.repository";
import VideoProjectRepository from "../../../src/repository/video-project.repository";

beforeEach(() => jest.clearAllMocks());

// `doc()` is mocked to throw, exactly as the real SDK does — so any of these
// reaching it fails loudly rather than passing on a lenient stub.
describe("a malformed document id is answered, not thrown", () => {
  it.each([
    ["ideas", async (id: string) => new ContentRepository().getIdea(id), undefined],
    ["scripts", async (id: string) => new ContentRepository().getScriptById(id), null],
    ["hooks", async (id: string) => new HooksRepository().findById(id), null],
    ["packaging", async (id: string) => new PackagingRepository().get(id), null],
    ["videoProjects", async (id: string) => new VideoProjectRepository().findById(id), null],
  ])("%s: a path-shaped id resolves to not-found", async (_name, read, expected) => {
    await expect(read("a/b")).resolves.toBe(expected);
    expect(docFn).not.toHaveBeenCalled();
  });

  it.each([["empty", ""], ["traversal", ".."], ["reserved", "__name__"]])(
    "rejects a %s id without reaching Firestore",
    async (_label, id) => {
      await expect(new VideoProjectRepository().findById(id)).resolves.toBeNull();
      expect(docFn).not.toHaveBeenCalled();
    }
  );
});
