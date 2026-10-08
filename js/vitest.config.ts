import type { ViteUserConfig } from "vitest/config";

export default {
  root: import.meta.dirname,
  test: {
    root: import.meta.dirname,
    coverage: { reportsDirectory: "coverage", exclude: ["plugin/src/generated/**"] },
    environment: "node",
    include: ["plugin/src/*.test.ts"],
    name: "@latticebuild/gazelle-js",
    pool: "threads",
    setupFiles: ["./plugin/tests/support/setup.ts"],
  },
} satisfies ViteUserConfig;
