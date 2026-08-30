// The composition root, which nothing imported.
//
// Every route file pulls its controller from `src/container.ts`, but no test did
// — and every integration test replaces the service class at the module boundary
// with a factory that ignores its constructor arguments entirely. So the real
// `new ContentService(repo, userRepo, videoProjectService, fakeAccountRepo(), researchContextService)`
// line was never executed under test.
//
// TypeScript catches a swap between two REQUIRED params of different classes. It
// does NOT catch a dropped OPTIONAL one — and the optional ones here are exactly
// the dependencies whose absence degrades silently rather than crashing:
//   - ContentService/PackagingService `researchContext?` — omit it and generation
//     still works, just ungrounded. Ideas quietly stop citing live research.
//   - HooksService `contextService` — omit it and `resolveScript` can no longer
//     find a stored script, so hooks generation 400s on projects that have one.
// A missing dependency that makes the product quieter instead of louder is the
// kind nobody notices for a month.

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

jest.mock("../../src/config/firebase", () => ({
  db: { collection: jest.fn() },
  auth: {},
  firebase: {
    firestore: {
      FieldValue: { serverTimestamp: jest.fn(), increment: jest.fn() },
      FieldPath: { documentId: jest.fn() },
    },
  },
}));

jest.mock("../../src/config/ai", () => ({
  __esModule: true,
  default: jest.fn(),
  embeddingModel: { embedContent: jest.fn() },
}));

import { fakeAccountRepo } from "../helpers/account";
import * as container from "../../src/container";
import ContentService from "../../src/service/content.service";
import HooksService from "../../src/service/hooks.service";
import PackagingService from "../../src/service/packaging.service";
import ResearchContextService from "../../src/service/research-context.service";
import ContextService from "../../src/service/context.service";
import StepRunner from "../../src/service/step-runner";
import VideoProjectService from "../../src/service/video-project.service";

/** Read a private constructor-assigned field without widening the class type. */
const dep = (instance: object, name: string): unknown =>
  (instance as unknown as Record<string, unknown>)[name];

describe("container — every controller is wired to a real service", () => {
  it("constructs each controller exactly once and exports it", () => {
    for (const name of [
      "hooksController",
      "ideaController",
      "packagingController",
      "researchController",
      "scriptController",
      "userController",
      "videoProjectController",
    ] as const) {
      expect(container[name]).toBeDefined();
    }
  });

  it("gives the idea and script controllers the SAME ContentService instance", () => {
    // Two ContentServices would mean two different research wirings — which is
    // exactly what the route files used to do before the container existed: one
    // passed researchContextService, the other did not.
    expect(dep(container.ideaController, "service")).toBe(container.contentService);
    expect(dep(container.scriptController, "service")).toBe(container.contentService);
  });

  it("shares one instance of each repository rather than minting duplicates", () => {
    expect(dep(container.videoProjectService, "repo")).toBe(container.videoProjectRepository);
    expect(dep(container.stepRunner, "projects")).toBe(container.videoProjectRepository);
  });
});

describe("container — the optional dependencies TypeScript cannot police", () => {
  it("gives ContentService its research context, so ideas stay grounded", () => {
    expect(container.contentService).toBeInstanceOf(ContentService);
    expect(dep(container.contentService, "researchContext")).toBeInstanceOf(ResearchContextService);
  });

  it("gives PackagingService its research context", () => {
    expect(container.packagingService).toBeInstanceOf(PackagingService);
    expect(dep(container.packagingService, "researchContext")).toBeInstanceOf(ResearchContextService);
  });

  it("gives HooksService a ContextService, so it can resolve a stored script", () => {
    // Without this, `resolveScript` falls straight through to a 400 for any
    // client that relies on the server finding the project's script.
    expect(container.hooksService).toBeInstanceOf(HooksService);
    expect(dep(container.hooksService, "contextService")).toBeInstanceOf(ContextService);
  });

  it("gives HooksService the step runner — a missing one would skip the lock and, from Phase 08, the debit", () => {
    expect(dep(container.hooksService, "steps")).toBeInstanceOf(StepRunner);
  });

  it("gives ContentService the video-project service, without which the stale cascade never fires", () => {
    expect(dep(container.contentService, "videoProjectService")).toBeInstanceOf(VideoProjectService);
  });
});
