import {
  onboardingSchema,
  prefillSchema,
  profileUpdateSchema,
} from "../../src/validation/user.validation";
import { validate } from "../../src/middleware/validate";
import { HttpError } from "../../src/utlils/errors";

const CHANNEL = "https://www.youtube.com/@mychannel";

const validOnboarding = {
  userName: CHANNEL,
  brandName: "Acme",
  niche: "AI tools",
  targetAudience: "founders",
};

describe("onboardingSchema", () => {
  it("accepts a minimal valid payload", () => {
    const result = onboardingSchema.safeParse(validOnboarding);
    expect(result.success).toBe(true);
  });

  it("trims strings and strips unknown keys", () => {
    const parsed = onboardingSchema.parse({
      ...validOnboarding,
      brandName: "  Acme  ",
      stats: { credits: 999 }, // must never survive from the client
      isAdmin: true,
    });
    expect(parsed.brandName).toBe("Acme");
    expect(parsed).not.toHaveProperty("stats");
    expect(parsed).not.toHaveProperty("isAdmin");
  });

  // 3.8: required minimum split by entry path.
  it("accepts the channel path — a channel URL alone is enough", () => {
    expect(onboardingSchema.safeParse({ userName: CHANNEL }).success).toBe(true);
  });

  it("accepts the no-channel path — niche + targetAudience, no URL", () => {
    expect(
      onboardingSchema.safeParse({ niche: "AI tools", targetAudience: "founders" })
        .success
    ).toBe(true);
  });

  it("no longer requires brandName", () => {
    const { brandName: _omit, ...noBrand } = validOnboarding;
    expect(onboardingSchema.safeParse(noBrand).success).toBe(true);
  });

  it("rejects when neither path is satisfied", () => {
    // no channel URL, and only one of niche/targetAudience
    expect(onboardingSchema.safeParse({ niche: "AI tools" }).success).toBe(false);
    expect(onboardingSchema.safeParse({ brandName: "Acme" }).success).toBe(false);
    expect(onboardingSchema.safeParse({}).success).toBe(false);
  });

  it("rejects a userName that is not a resolvable YouTube URL", () => {
    const result = onboardingSchema.safeParse({
      ...validOnboarding,
      userName: "https://example.com/some-page",
    });
    expect(result.success).toBe(false);
  });

  it.each([
    "https://youtube.com/@handle",
    "https://www.youtube.com/channel/UCabcdefghijklmnopqrstuv",
    "youtube.com/c/SomeName",
    "https://youtube.com/user/LegacyName",
  ])("accepts valid channel URL forms: %s", (url) => {
    expect(
      onboardingSchema.safeParse({ ...validOnboarding, userName: url }).success
    ).toBe(true);
  });

  it("rejects an invalid website URL but accepts empty string", () => {
    expect(
      onboardingSchema.safeParse({ ...validOnboarding, website: "nope" }).success
    ).toBe(false);
    expect(
      onboardingSchema.safeParse({ ...validOnboarding, website: "" }).success
    ).toBe(true);
    expect(
      onboardingSchema.safeParse({
        ...validOnboarding,
        website: "https://acme.io",
      }).success
    ).toBe(true);
  });

  it("validates competitor array shape and cap", () => {
    expect(
      onboardingSchema.safeParse({
        ...validOnboarding,
        competitors: [CHANNEL, "not-a-channel"],
      }).success
    ).toBe(false);
    expect(
      onboardingSchema.safeParse({
        ...validOnboarding,
        competitors: Array.from({ length: 21 }, () => CHANNEL),
      }).success
    ).toBe(false);
  });

  it("rejects an unknown format value", () => {
    expect(
      onboardingSchema.safeParse({ ...validOnboarding, format: "cartoon" })
        .success
    ).toBe(false);
    expect(
      onboardingSchema.safeParse({ ...validOnboarding, format: "faceless" })
        .success
    ).toBe(true);
  });
});

describe("profileUpdateSchema", () => {
  it("accepts partial updates and an empty body", () => {
    expect(profileUpdateSchema.safeParse({ niche: "finance" }).success).toBe(true);
    expect(profileUpdateSchema.safeParse({}).success).toBe(true);
  });

  it("still enforces per-field rules when a field is present", () => {
    expect(profileUpdateSchema.safeParse({ userName: "bad" }).success).toBe(false);
  });
});

describe("prefillSchema", () => {
  it("requires a valid YouTube channel URL", () => {
    expect(
      prefillSchema.safeParse({ channelUrl: CHANNEL }).success
    ).toBe(true);
    expect(
      prefillSchema.safeParse({ channelUrl: "https://example.com" }).success
    ).toBe(false);
    expect(prefillSchema.safeParse({}).success).toBe(false);
  });
});

describe("validate middleware", () => {
  const run = (schema: Parameters<typeof validate>[0], body: unknown) => {
    const req = { body } as never as { body: unknown };
    const next = jest.fn();
    validate(schema)(req as never, {} as never, next as never);
    return { req, next };
  };

  it("replaces req.body with the parsed value and calls next() with no error", () => {
    const { req, next } = run(onboardingSchema, {
      ...validOnboarding,
      brandName: "  Trimmed  ",
    });
    expect(next).toHaveBeenCalledTimes(1);
    expect(next.mock.calls[0][0]).toBeUndefined();
    expect((req.body as { brandName: string }).brandName).toBe("Trimmed");
  });

  it("forwards a 400 HttpError with a field-prefixed message on failure", () => {
    const { next } = run(onboardingSchema, { brandName: "Acme" });
    const err = next.mock.calls[0][0];
    expect(err).toBeInstanceOf(HttpError);
    expect(err.statusCode).toBe(400);
    expect(err.message).toMatch(/userName|niche|targetAudience/);
  });
});
