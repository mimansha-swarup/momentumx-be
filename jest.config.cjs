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
        tsconfig: {
          module: "CommonJS",
          moduleResolution: "node",
          strict: false,
          noImplicitAny: false,
          esModuleInterop: true,
          allowSyntheticDefaultImports: true,
          types: ["node", "jest"],
        },
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
