jest.mock("../../../src/config/firebase", () => require("../../helpers/fake-firestore").mockFirebase());
import VideoProjectRepository from "../../../src/repository/video-project.repository";
const store = require("../../../src/config/firebase").__db;
it("serializes document timestamps, preserves step timestamps, and hydrates legacy title", async () => {
  const startedAt = { toMillis: () => 1, toDate: () => new Date(1) };
  store.seed("videoProjects", [{ id: "p", createdAt: { toDate: () => new Date("2026-09-01Z") }, updatedAt: { toDate: () => new Date("2026-09-02Z") }, pipeline: { hooks: { status: "stale", startedAt } } }]);
  const project = await new VideoProjectRepository().findById("p");
  expect(project?.createdAt).toBe("2026-09-01T00:00:00.000Z");
  expect(project?.updatedAt).toBe("2026-09-02T00:00:00.000Z");
  expect(project?.pipeline.hooks.startedAt?.toMillis()).toBe(1);
  expect(project?.pipeline.title.status).toBe("not_started");
});
it("does not require legacy documents to have document timestamps", async () => {
  store.seed("videoProjects", [{ id: "legacy", pipeline: {} }]);
  await expect(new VideoProjectRepository().findById("legacy")).resolves.toMatchObject({ id: "legacy" });
});
