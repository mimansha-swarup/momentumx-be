// Behaviour tests for the Onboarding flow, derived from the documented
// contract (not the implementation) in:
//   - .claude/rules/api-design.md (route table: "PATCH /onboarding — complete
//     brand setup (required minimum: channel URL, OR niche + targetAudience)")
//   - docs/features/onboarding/spec.md ("What Happens on Submission" — prefill
//     is suggestions only, nothing persisted; enrichment failures are isolated
//     per-source and never blank already-stored data)
//
// NOTE ON DOC DRIFT: docs/features/onboarding/spec.md and api.md (last_updated
// 2026-03-17) say "No server-side validation — missing required fields will
// produce degraded AI generation output, not a 400 error." That is stale.
// src/validation/user.validation.ts (`onboardingSchema`) DOES enforce the
// channel-URL-OR-niche+targetAudience minimum, wired at the route via
// `validate(onboardingSchema)` (src/routes/v1/user.route.ts), and is already
// exhaustively unit-tested in tests/unit/user.validation.test.ts. This file
// does not re-test the schema in isolation; it tests the SERVICE-LAYER
// contract that depends on/complements it — the part not already covered by
// tests/unit/user.prefill.test.ts and tests/unit/user.refresh-context.test.ts
// (both of which mock formatUserData away entirely).

jest.mock("firebase-admin", () => ({
  apps: [],
  initializeApp: jest.fn(),
  credential: { cert: jest.fn() },
  firestore: Object.assign(jest.fn().mockReturnValue({}), {
    FieldValue: { serverTimestamp: jest.fn().mockReturnValue("SERVER_TS") },
  }),
  auth: jest.fn().mockReturnValue({ verifyIdToken: jest.fn() }),
}));

jest.mock("../../../src/config/firebase", () => ({
  db: {},
  auth: {},
  firebase: { firestore: { FieldValue: { serverTimestamp: jest.fn().mockReturnValue("SERVER_TS") } } },
}));

jest.mock("../../../src/config/ai", () => ({
  __esModule: true,
  default: jest.fn(),
  embeddingModel: { embedContent: jest.fn() },
}));

// resolveChannel is mocked (network-bound); formatUserData is kept REAL so the
// refresh-context "never blanks stored enrichment on failure" contract is
// exercised through the actual degrade-to-omit logic, not a stand-in.
jest.mock("../../../src/utlils/content", () => {
  const actual = jest.requireActual("../../../src/utlils/content");
  return { ...actual, resolveChannel: jest.fn() };
});

jest.mock("../../../src/utlils/ai", () => ({
  collectJson: jest.requireActual("../../../src/utlils/ai").collectJson,
  generateStreamingContent: jest.fn(),
  generateContent: jest.fn(),
}));

jest.mock("../../../src/repository/user.repository");

import UserService from "../../../src/service/user.service";
import UserRepository from "../../../src/repository/user.repository";
import { onboardingSchema } from "../../../src/validation/user.validation";
import { resolveChannel } from "../../../src/utlils/content";

const mockResolveChannel = resolveChannel as jest.Mock;

// A global fetch failure simulates the real-world trigger for the "never
// blanks stored enrichment" contract (YouTube quota exhaustion, network
// outage) — it fails BOTH the website scrape (ExtractService.getWebsiteContent,
// direct fetch) and the channel/competitor lookups (ExtractRepository's
// fetch-based calls), without needing to reach into either class's internals.
const originalFetch = global.fetch;
beforeAll(() => {
  global.fetch = jest.fn().mockRejectedValue(new Error("network down")) as unknown as typeof fetch;
});
afterAll(() => {
  global.fetch = originalFetch;
});

describe("Onboarding — the required minimum (channel URL OR niche+targetAudience)", () => {
  // Service-layer complement to the exhaustive schema tests in
  // tests/unit/user.validation.test.ts: prove the two documented entry paths
  // both reach the service and persist via createOnboardingData exactly as
  // submitted (fast-save — no inline enrichment), since a route-level pass
  // that the service then mishandles would still break onboarding end to end.
  let service: UserService;
  let repo: jest.Mocked<UserRepository>;

  beforeEach(() => {
    jest.clearAllMocks();
    repo = new UserRepository() as jest.Mocked<UserRepository>;
    service = new UserService(repo as never);
    repo.add = jest.fn().mockResolvedValue(undefined);
  });

  it("the channel-URL path validates and persists without niche/targetAudience", async () => {
    const body = { userName: "https://youtube.com/@me" };
    const parsed = onboardingSchema.parse(body);

    const result = await service.createOnboardingData("user-1", parsed as never);

    expect(repo.add).toHaveBeenCalledWith("user-1", parsed);
    expect(result).toBe(parsed);
  });

  it("the no-channel path validates and persists with niche+targetAudience alone", async () => {
    const body = { niche: "AI tools", targetAudience: "founders" };
    const parsed = onboardingSchema.parse(body);

    const result = await service.createOnboardingData("user-1", parsed as never);

    expect(repo.add).toHaveBeenCalledWith("user-1", parsed);
    expect(result).toBe(parsed);
  });

  it("neither path satisfied — the schema itself rejects before any service call would happen", () => {
    // The route wires `validate(onboardingSchema)` before the controller, so a
    // payload failing this parse never reaches createOnboardingData at all.
    expect(() => onboardingSchema.parse({ brandName: "Acme" })).toThrow();
    expect(repo.add).not.toHaveBeenCalled();
  });
});

describe("Onboarding prefill — persists NOTHING (suggestions only)", () => {
  let service: UserService;
  let repo: jest.Mocked<UserRepository>;

  beforeEach(() => {
    jest.clearAllMocks();
    repo = new UserRepository() as jest.Mocked<UserRepository>;
    repo.add = jest.fn();
    repo.update = jest.fn();
    service = new UserService(repo as never);
  });

  it("never touches the user repository, on a resolvable channel", async () => {
    mockResolveChannel.mockResolvedValue({ id: "chan-1", description: "", titles: [] });

    await service.prefillFromChannel("https://youtube.com/@x");

    expect(repo.add).not.toHaveBeenCalled();
    expect(repo.update).not.toHaveBeenCalled();
  });

  it("never touches the user repository, even when channel resolution fails entirely", async () => {
    mockResolveChannel.mockResolvedValue(null);

    await service.prefillFromChannel("https://youtube.com/@x");

    expect(repo.add).not.toHaveBeenCalled();
    expect(repo.update).not.toHaveBeenCalled();
  });
});

describe("Refresh-context — a source failure never blanks stored enrichment (real formatUserData)", () => {
  let service: UserService;
  let repo: jest.Mocked<UserRepository>;

  beforeEach(() => {
    jest.clearAllMocks();
    repo = new UserRepository() as jest.Mocked<UserRepository>;
    service = new UserService(repo as never);
    repo.update = jest.fn().mockResolvedValue(undefined);
  });

  it("when YouTube/website lookups are all down, the update payload OMITS the enriched fields entirely rather than writing them empty — so Firestore's merge leaves the previously-good values untouched", async () => {
    repo.get = jest.fn().mockResolvedValue({
      userName: "https://youtube.com/@me",
      website: "https://example.com",
      niche: "AI tools",
      targetAudience: "founders",
      brandName: "MomentumX",
      // Previously-good enrichment already on the stored doc — must survive.
      channelId: "chan-good",
      channelDescription: "Good description",
      userTitle: ["Good title 1", "Good title 2"],
      websiteContent: "Good scraped content",
      competitors: [{ url: "https://youtube.com/@rival", id: "chan-rival", titles: ["Rival hit"] }],
    });

    await service.refreshContext("user-1");

    const written = (repo.update as jest.Mock).mock.calls[0][1] as Record<string, unknown>;

    // The user's own submitted fields always round-trip.
    expect(written.niche).toBe("AI tools");
    expect(written.targetAudience).toBe("founders");

    // Every enrichment source failed -> none of these keys are present in the
    // write at all (repo.update uses Firestore `.set(..., {merge:true})`,
    // so an omitted key leaves the stored value alone; the outage must not
    // silently blank a working profile).
    expect(written).not.toHaveProperty("channelId");
    expect(written).not.toHaveProperty("channelDescription");
    expect(written).not.toHaveProperty("userTitle");
    expect(written).not.toHaveProperty("websiteContent");

    // A resolved-but-failed competitor keeps its URL with empty enrichment
    // (documented degrade, not omission — competitors is always a known list).
    expect(written.competitors).toEqual([{ url: "https://youtube.com/@rival", id: "", titles: [] }]);
  });

  it("still returns a completeness score computed from what DID survive, not a crash", async () => {
    repo.get = jest.fn().mockResolvedValue({
      userName: "https://youtube.com/@me",
      niche: "AI tools",
      targetAudience: "founders",
    });

    const result = await service.refreshContext("user-1");

    expect(result.completeness.score).toBeGreaterThan(0);
  });
});
