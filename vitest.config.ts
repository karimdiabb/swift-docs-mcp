import { defineConfig } from "vitest/config";

// Unit tests: no network. Integration tests live in tests/integration and run only via test:integration.
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: ["tests/integration/**", "node_modules/**"],
  },
});
