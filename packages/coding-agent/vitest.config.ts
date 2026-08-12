import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The real Agent replacement integration test has bounded waits up to 10s.
    // Keep the harness deadline above that budget so CI measures the proof
    // instead of terminating it at Vitest's 5s default.
    testTimeout: 15_000,
  },
});
