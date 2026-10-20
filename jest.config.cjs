/** @type {import('jest').Config} */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  roots: ["<rootDir>/tests"],
  testMatch: ["**/*.test.ts"],
  setupFiles: ["<rootDir>/tests/setup-env.cjs"],
  moduleNameMapper: {
    // Strip .js extensions so ts-jest can resolve .ts source files
    "^(\\.{1,2}/.*)\\.js$": "$1",
  },
  transform: {
    "^.+\\.ts$": [
      "ts-jest",
      {
        // POINTS AT tsconfig.test.json rather than repeating its options.
        //
        // These were duplicated inline, and had drifted: this block disabled `strict`
        // and `noImplicitAny` entirely, so tests RAN with no strict checking even
        // though the gate demanded it. One source of truth removes the drift — a
        // change to the gate now changes what jest enforces, by construction.
        tsconfig: "tsconfig.test.json",
      },
    ],
  },
  // NOTE: `clearMocks` (mockClear) resets call history but does NOT drain a
  // queued `mockResolvedValueOnce`. See the `beforeEach` in the integration
  // suites, which drain it explicitly. `resetMocks: true` would drain it globally
  // but also wipes module-scope `mockImplementation`s that ~11 unit suites depend
  // on (126 failures when tried), so the fix is local to the suites that queue.
  clearMocks: true,
};
