import { defineConfig } from "vitest/config";

// Opt-in: real requests to Apple. Run with `npm run test:integration`.
export default defineConfig({
  test: {
    include: ["tests/integration/**/*.test.ts"],
    testTimeout: 60_000,
  },
});
