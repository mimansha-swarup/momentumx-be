/** Independent wire contracts: real mounted routers/controllers, service boundaries mocked. */
jest.mock("../../src/config/firebase", () => ({
  db: {},
  firebase: {
    auth: () => ({ verifyIdToken: async () => ({ uid: "reviewer" }) }),
  },
}));
jest.mock("../../src/middleware/account", () =>
  require("../helpers/account").passthroughAccountMiddleware("a"),
);
jest.mock("../../src/service/event.service", () => ({
  eventService: { capture: jest.fn() },
}));
const mockProfile = {
  uid: "reviewer",
  name: "Reviewer",
  brandName: "Test brand",
  niche: "Cooking",
  targetAudience: "Beginners",
  userName: "https://youtube.com/@fixture",
  website: "https://example.test",
  format: "talking_head",
  websiteContent: "PRIVATE_SCRAPE",
  userTitle: ["PRIVATE_SCRAPE"],
  channelDescription: "PRIVATE_SCRAPE",
  competitors: [
    { url: "https://youtube.com/@competitor", titles: ["PRIVATE_SCRAPE"] },
  ],
  unknown: "PRIVATE_SCRAPE",
};
const mockAccount = {
  id: "a",
  name: "Channel",
  isOnboarded: true,
  members: { reviewer: { role: "owner" }, other: { role: "editor" } },
  memberUids: ["reviewer", "other"],
  ownerUids: ["reviewer"],
  billingOwnerUid: "reviewer",
  generationLocks: { token: "PRIVATE_LOCK" },
  unknown: "PRIVATE_LOCK",
};
const mockProject = {
  id: "p",
  title: "Project",
  ideaId: "i",
  accountId: "a",
  pipeline: {
    research: {
      status: "completed",
      completedAt: "2026-01-01",
      token: "PRIVATE_LOCK",
    },
  },
  generationLocks: { token: "PRIVATE_LOCK" },
  unknown: "PRIVATE_LOCK",
  isDeleted: false,
};
const mockUser = {
  getProfile: async () => mockProfile,
  updateProfile: async () => mockProfile,
  createOnboardingData: async () => mockProfile,
  refreshContext: async () => mockProfile,
  prefillFromChannel: async () => ({
    suggestions: {
      niche: "Cooking",
      targetAudience: "Beginners",
      brandName: "Test brand",
    },
    channel: {
      channelDescription: "Editable description",
      topTitles: ["Useful title"],
    },
  }),
};
const mockAccounts = {
  getAccount: async () => mockAccount,
  createAccount: async () => mockAccount,
  bootstrapAccount: async () => mockAccount,
  updateAccount: async () => mockAccount,
  listAccounts: async () => [],
  resolveActiveAccountId: async () => null,
};
const mockProjects = {
  create: async () => mockProject,
  createFromTitle: async () => mockProject,
  getReconciledById: async () => mockProject,
  list: async () => ({ projects: [mockProject], meta: { hasNextPage: false } }),
  delete: async () => ({ ...mockProject, isDeleted: true }),
};
jest.mock("../../src/container", () => ({
  userController: new (require("../../src/controller/user.controller").default)(
    mockUser,
  ),
  accountController:
    new (require("../../src/controller/account.controller").default)(
      mockAccounts,
    ),
  videoProjectController:
    new (require("../../src/controller/video-project.controller").default)(
      mockProjects,
    ),
}));
import express from "express";
import request from "supertest";
import { responseFormatter } from "../../src/middleware/response_formatter";
import { errorHandler } from "../../src/middleware/error_handler";
import user from "../../src/routes/v1/user.route";
import accounts from "../../src/routes/v1/account.route";
import projects from "../../src/routes/v1/video-project.route";
import { useSharedServer } from "./shared-server";
const app = express();
app.use(responseFormatter, express.json());
app.use("/v1/user", user);
app.use("/v1/accounts", accounts);
app.use("/v1/video-projects", projects);
app.use(errorHandler);
const server = useSharedServer(app);
test.each(["get", "patch", "refresh", "onboard"])(
  "profile %s keeps consumed form fields and removes enrichment",
  async (kind) => {
    const call =
      kind === "get"
        ? request(server()).get("/v1/user/profile")
        : kind === "patch"
          ? request(server())
              .patch("/v1/user/profile")
              .send({ brandName: "Test brand" })
          : kind === "refresh"
            ? request(server()).post("/v1/user/refresh-context")
            : request(server())
                .patch("/v1/user/onboarding")
                .send({ niche: "Cooking", targetAudience: "Beginners" });
    const res = await call.set("Authorization", "Bearer fixture");
    expect(res.status).toBe(200);
    expect(res.text).not.toContain("PRIVATE_SCRAPE");
    const profile = res.body.data.payload ?? res.body.data;
    expect(profile).toMatchObject({
      niche: "Cooking",
      brandName: "Test brand",
      targetAudience: "Beginners",
      website: "https://example.test",
      format: "talking_head",
    });
    expect(profile.competitors).toEqual([
      { url: "https://youtube.com/@competitor" },
    ]);
  },
);
test("prefill retains description and topTitles needed for editable suggestions/context override", async () => {
  const res = await request(server())
    .post("/v1/user/onboarding/prefill")
    .set("Authorization", "Bearer fixture")
    .send({ channelUrl: "https://youtube.com/@fixture" });
  expect(res.status).toBe(200);
  expect(res.body.data.channel).toEqual({
    channelDescription: "Editable description",
    topTitles: ["Useful title"],
  });
  expect(res.body.data.suggestions.niche).toBe("Cooking");
});
test.each(["get", "patch", "create", "bootstrap"])(
  "account %s preserves caller role but strips roster and locks",
  async (kind) => {
    const call =
      kind === "get"
        ? request(server()).get("/v1/accounts/a")
        : kind === "patch"
          ? request(server())
              .patch("/v1/accounts/a")
              .send({ displayName: "Renamed" })
          : request(server())
              .post(
                kind === "create" ? "/v1/accounts" : "/v1/accounts/bootstrap",
              )
              .send({});
    const res = await call.set("Authorization", "Bearer fixture");
    expect([200, 201]).toContain(res.status);
    expect(res.text).not.toMatch(
      /PRIVATE_LOCK|"members"|memberUids|ownerUids|billingOwnerUid/,
    );
    expect(res.body.data.account).toMatchObject({
      id: "a",
      role: "owner",
      isBillingOwner: true,
      memberCount: 2,
    });
  },
);
test.each(["get", "list", "create", "delete"])(
  "project %s strips internal tokens and preserves required output",
  async (kind) => {
    const call =
      kind === "get"
        ? request(server()).get("/v1/video-projects/p")
        : kind === "list"
          ? request(server()).get("/v1/video-projects")
          : kind === "create"
            ? request(server())
                .post("/v1/video-projects")
                .send({ title: "Project" })
            : request(server()).delete("/v1/video-projects/p");
    const res = await call.set("Authorization", "Bearer fixture");
    expect([200, 201]).toContain(res.status);
    expect(res.text).not.toContain("PRIVATE_LOCK");
    if (kind === "delete")
      expect(res.body.data).toEqual({ id: "p", isDeleted: true });
    else {
      const p = kind === "list" ? res.body.data.projects[0] : res.body.data;
      expect(p).toMatchObject({
        id: "p",
        title: "Project",
        ideaId: "i",
        pipeline: { research: { status: "completed" } },
      });
    }
  },
);
