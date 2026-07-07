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
  clearMocks: true,
};
