const original = process.env.CREDIT_COST_SCRIPT;
afterEach(() => {
  if (original === undefined) delete process.env.CREDIT_COST_SCRIPT;
  else process.env.CREDIT_COST_SCRIPT = original;
});
it.each(["0x10", "1e2", "1.5", "-1", "", "  "])("refuses a non-decimal integer price %p", value => {
  process.env.CREDIT_COST_SCRIPT = value;
  expect(() => jest.isolateModules(() => require("../../src/constants/credits"))).toThrow("Invalid CREDIT_COST_SCRIPT");
});
it("permits an explicit free price while retaining the typed default price list", () => {
  process.env.CREDIT_COST_SCRIPT = "0";
  jest.isolateModules(() => {
    const { CREDIT_COSTS } = require("../../src/constants/credits");
    expect(CREDIT_COSTS).toMatchObject({ script: 0, ideas: 3, prefill: 0, description: 2, thumbnail: 1, shorts: 1 });
  });
});
