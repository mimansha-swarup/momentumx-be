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
import AccountRepository from "../../../src/repository/account.repository";
import { isDocumentId } from "../../../src/utlils/firestore-id";

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
    // The one the guard's own docstring is written about, and the one it was
    // not applied to: `req.params.id` on GET/PATCH/DELETE /v1/accounts/:id
    // reaches here untouched, because accountMiddleware validates the HEADER.
    ["accounts", async (id: string) => new AccountRepository().findById(id), null],
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

describe("the account repository refuses a path-shaped id on every entry point", () => {
  it.each([
    ["findById", (r: AccountRepository, id: string) => r.findById(id)],
    ["getContext", (r: AccountRepository, id: string) => r.getContext(id)],
  ])("%s resolves to null rather than reading a subcollection document", async (_n, call) => {
    // The even-segment case is the dangerous one: `<other-id>/context/channel`
    // is a VALID document path, so it resolved and really read another
    // channel's niche, competitors and website scrape.
    await expect(call(new AccountRepository(), "victim/context/channel")).resolves.toBeNull();
    expect(docFn).not.toHaveBeenCalled();
  });

  it.each([
    ["writeContext", (r: AccountRepository, id: string) => r.writeContext(id, { niche: "x" })],
    ["update", (r: AccountRepository, id: string) => r.update(id, { displayName: "x" })],
  ])("%s refuses rather than writing to a path it was handed", async (_n, call) => {
    await expect(call(new AccountRepository(), "victim/context/channel")).rejects.toMatchObject({
      statusCode: 404,
    });
    expect(docFn).not.toHaveBeenCalled();
  });
});

describe("isDocumentId measures bytes, as Firestore does", () => {
  it("accepts a 1500-byte ascii id and rejects 1501", () => {
    expect(isDocumentId("a".repeat(1500))).toBe(true);
    expect(isDocumentId("a".repeat(1501))).toBe(false);
  });

  it("rejects a multi-byte id that is under 1500 CHARACTERS but over 1500 bytes", () => {
    // 500 four-byte characters = 500 UTF-16 length units by `.length`, 2000
    // bytes to Firestore. The character-count version accepted it and the write
    // failed at the SDK.
    expect(isDocumentId("\u{1F600}".repeat(500))).toBe(false);
  });
});
