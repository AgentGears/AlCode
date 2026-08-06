import { defineConfig } from "vitest/config";

// Root vitest config — discovers tests across all workspace packages.
// Note: tests are invoked from the repository root, never with `--root <pkg>`
// (which would re-evaluate this `include` relative to the package and match
// nothing). To run one package's tests, pass a path filter:
//   pnpm exec vitest run packages/events/src
export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts"],
    environment: "node",
    reporters: ["default"],
    pool: "forks",
  },
});
