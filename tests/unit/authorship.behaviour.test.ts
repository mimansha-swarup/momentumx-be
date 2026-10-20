/**
 * Authorship survives to STORAGE, on every creation path.
 *
 * `firestore-conventions.md`: `accountId` is the permission field, `createdBy` is
 * authorship only — "still written on every record, still useful for 'who made
 * this', and never a permission decision". Phase 09 is where that matters: once a
 * channel has two members, `createdBy` is the only field that can answer which of
 * them wrote a document, and nothing else in the schema can reconstruct it.
 *
 * `dual-write-coverage.test.ts` used to claim this with one regex over the
 * concatenated service sources — `/createdBy:\s*\w/` — which a single surviving
 * fragment anywhere (a COMMENT included, the source was not stripped) satisfied
 * while every write path dropped the author. This is that claim, made per path,
 * against the document that actually lands in the collection.
 *
 * Deliberately end-of-path: the real document builder AND the real repository,
 * over `tests/helpers/fake-firestore`, then read back out of the store. The
 * existing suites assert the value handed to a MOCK repo, which cannot see a
 * repository that enumerates fields and omits one — which `event.repository.add`
 * does by construction, and `saveWithId`/`create`/`batchSaveIdeas` are one edit
 * away from doing.
 */

const embedContent = jest.fn().mockResolvedValue({ embedding: { values: [0.1] } });
jest.mock("../../src/config/ai", () => ({ embeddingModel: { embedContent } }));
jest.mock("../../src/config/firebase", () =>
  require("../helpers/fake-firestore").mockFirebase()
);
jest.mock("../../src/utlils/ai", () => ({
  generateStreamingContent: jest.fn(),
  collectJson: jest.requireActual("../../src/utlils/ai").collectJson,
}));

import type { FakeFirestore } from "../helpers/fake-firestore";
import ContentRepository from "../../src/repository/content.repository";
import HooksRepository from "../../src/repository/hooks.repository";
import PackagingRepository from "../../src/repository/packaging.repository";
import VideoProjectRepository from "../../src/repository/video-project.repository";
import EventRepository from "../../src/repository/event.repository";
import EventService from "../../src/service/event.service";
import HooksService from "../../src/service/hooks.service";
import PackagingService from "../../src/service/packaging.service";
import VideoProjectService from "../../src/service/video-project.service";
import { generateStreamingContent } from "../../src/utlils/ai";
import {
  formatGeneratedIdea,
  formatGeneratedScript,
} from "../../src/utlils/content";
import { EventType } from "../../src/types/routes/event";
import { unmeteredSteps } from "../helpers/step-runner";
import { TEST_ACCOUNT_ID, testOwner } from "../helpers/account";

const store = require("../../src/config/firebase").__db as FakeFirestore;
const mockGenerate = generateStreamingContent as jest.MockedFunction<
  typeof generateStreamingContent
>;

const UID = "user-1";
const OWNER = testOwner(UID);

const flush = () => new Promise((resolve) => setImmediate(resolve));

const stream = (text: string) =>
  ({
    stream: (async function* () {
      yield { text: () => text };
    })(),
  }) as never;

const project = (overrides: Record<string, unknown> = {}) => ({
  id: "proj-1",
  createdBy: UID,
  accountId: TEST_ACCOUNT_ID,
  title: "My Video",
  ideaId: "idea-1",
  scriptId: "script-1",
  hooksId: null,
  packagingId: null,
  isDeleted: false,
  overallStatus: "in_progress",
  currentStep: "script",
  pipeline: {
    research: { status: "completed", startedAt: null, completedAt: null },
    script: { status: "completed", startedAt: null, completedAt: null },
    hooks: { status: "not_started", startedAt: null, completedAt: null },
    title: { status: "not_started", startedAt: null, completedAt: null },
    packaging: { status: "not_started", startedAt: null, completedAt: null },
  },
  ...overrides,
});

/** Every collaborator that is not part of the authorship stamp. */
const vpStub = () =>
  ({
    getById: jest.fn(async () => project()),
    linkResource: jest.fn(async () => undefined),
    update: jest.fn(async () => undefined),
    startStep: jest.fn(async () => undefined),
    completeStep: jest.fn(async () => undefined),
  }) as unknown as VideoProjectService;

beforeEach(() => {
  store.data.clear();
  embedContent.mockResolvedValue({ embedding: { values: [0.1] } });
});

/**
 * One case per creation path. Each drives the REAL code that builds the document
 * and the REAL repository that writes it, then names the collection to read back.
 *
 * Seven paths, matching the seven tenancy collections. A path added without an
 * entry here is caught by the count assertion at the bottom of the file.
 */
const PATHS: [collection: string, write: () => Promise<unknown>][] = [
  [
    // POST /v1/ideas/generate — the highest-volume write in the system.
    "ideas",
    async () => {
      const doc = await formatGeneratedIdea(
        { workingTitle: "My Idea", concept: "c", type: "long", evidence: "e" },
        OWNER,
        "batch-1"
      );
      await new ContentRepository().batchSaveIdeas([doc]);
    },
  ],
  [
    // GET /v1/scripts/stream/:projectId — the post-stream save.
    "scripts",
    async () => {
      const doc = formatGeneratedScript(
        "T",
        "script-1",
        "idea-1",
        "proj-1",
        "the script body",
        OWNER
      );
      await new ContentRepository().saveScript("script-1", doc);
    },
  ],
  [
    // POST /v1/hooks/generate
    "hooks",
    async () => {
      mockGenerate.mockResolvedValue(
        stream('{"hooks":["h1","h2","h3","h4","h5"]}')
      );
      const service = new HooksService(
        new HooksRepository(),
        vpStub(),
        undefined,
        unmeteredSteps,
        undefined as never
      );
      await service.generate(OWNER, "proj-1", "a script");
    },
  ],
  [
    // POST /v1/packaging/save — user edits, first save creates the document.
    "packaging",
    async () => {
      const service = new PackagingService(
        new PackagingRepository(),
        vpStub(),
        undefined as never,
        undefined as never,
        undefined,
        unmeteredSteps
      );
      await service.savePackaging(OWNER, { description: "a description" }, "proj-1");
    },
  ],
  [
    // POST /v1/packaging/generate-* — persist-on-generate, inside the transaction.
    "packaging",
    async () => {
      await new PackagingRepository().upsertGeneratedItem(
        "proj-2",
        OWNER,
        "titles",
        "title",
        [{ title: "A" }]
      );
    },
  ],
  [
    // POST /v1/video-projects
    "videoProjects",
    async () => {
      const contentRepo = {
        getIdea: jest.fn(async () => ({
          id: "idea-1",
          title: "My Idea",
          accountId: TEST_ACCOUNT_ID,
          createdBy: UID,
        })),
        updateIdea: jest.fn(async () => undefined),
      } as unknown as ContentRepository;
      const service = new VideoProjectService(
        new VideoProjectRepository(),
        contentRepo,
        undefined as never,
        undefined as never,
        undefined as never
      );
      await service.create(OWNER, "idea-1");
    },
  ],
  [
    // Telemetry. Fire-and-forget, and the one repository that enumerates the
    // stored fields by hand rather than spreading the document.
    "events",
    async () => {
      new EventService(new EventRepository()).capture(OWNER, EventType.EXPORT, {
        resource: "idea",
      });
      await flush();
    },
  ],
];

describe.each(PATHS.map((p, i) => [`${p[0]} (path ${i + 1})`, ...p] as const))(
  "%s stores the authenticated author",
  (_label, collection, write) => {
    it("stamps createdBy with the requesting uid", async () => {
      await write();

      const stored = store.all(collection);
      expect(stored).toHaveLength(1);
      expect(stored[0].createdBy).toBe(UID);
    });

    it("does not confuse the author with the channel", async () => {
      // The two live in disjoint id spaces on purpose. A swap keeps every
      // permission check passing (one member per channel today) and quietly
      // destroys authorship, which is unrecoverable once written.
      await write();

      const [stored] = store.all(collection);
      expect(stored.accountId).toBe(TEST_ACCOUNT_ID);
      expect(stored.createdBy).not.toBe(stored.accountId);
    });
  }
);

it("covers every collection that carries an author", () => {
  // The list above is only as good as its completeness. `accounts`, `billing`,
  // `invites` and `users` are excluded deliberately: none of them stores
  // `createdBy` (membership, ownership and the invite's own email carry that
  // information), so a path added to one of those is not an authorship path.
  expect(new Set(PATHS.map(([collection]) => collection))).toEqual(
    new Set(["ideas", "scripts", "hooks", "packaging", "videoProjects", "events"])
  );
  // Two packaging paths — the save door and persist-on-generate — write the same
  // collection through different code. Counting the paths, not the collections,
  // is what makes losing one of them visible.
  expect(PATHS).toHaveLength(7);
});
