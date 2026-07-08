import { generateIdeasSchema } from "../../src/validation/content.validation";

describe("generateIdeasSchema", () => {
  it("accepts an empty body (normal generation from the stored record)", () => {
    expect(generateIdeasSchema.safeParse({}).success).toBe(true);
    const parsed = generateIdeasSchema.parse({});
    expect(parsed.context).toBeUndefined();
  });

  it("accepts a partial instant-idea context and trims strings", () => {
    const parsed = generateIdeasSchema.parse({
      context: { niche: "  Personal finance  ", topTitles: ["A", "B"] },
    });
    expect(parsed.context?.niche).toBe("Personal finance");
    expect(parsed.context?.topTitles).toEqual(["A", "B"]);
  });

  it("strips unknown keys inside context", () => {
    const parsed = generateIdeasSchema.parse({
      context: { niche: "AI", isAdmin: true },
    });
    expect(parsed.context).not.toHaveProperty("isAdmin");
  });

  it("rejects a non-array topTitles and an over-cap list", () => {
    expect(
      generateIdeasSchema.safeParse({ context: { topTitles: "nope" } }).success
    ).toBe(false);
    expect(
      generateIdeasSchema.safeParse({
        context: { topTitles: Array.from({ length: 21 }, () => "t") },
      }).success
    ).toBe(false);
  });
});
