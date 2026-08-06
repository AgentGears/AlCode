import { defineConfig } from "vitest/config";

// Package-local config. `include` is relative to this package's root, so
// `vitest run` from the package directory picks up `src/**/*.test.ts` without
// conflicting with the repository-root config's `packages/*/src/**` pattern.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    reporters: ["default"],
    pool: "forks",
  },
});
