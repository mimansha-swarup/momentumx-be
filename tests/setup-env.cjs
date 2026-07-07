// Jest setup: config modules fail fast on missing env vars at import time.
// config/firebase is jest.mock()ed per-suite; config/ai is imported for real,
// so give it a dummy key (no Gemini call ever runs in unit tests).
process.env.API_KEY = process.env.API_KEY || "test-api-key";
