import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Modules using process-global state (logger streams, Flant, cbm daemon) clobber
    // each other when test files run in parallel; serial execution keeps them isolated.
    fileParallelism: false,
    setupFiles: ["./vitest.setup.ts"],
    coverage: {
      provider: "v8",
      include: ["extensions/**/*.ts"],
      exclude: ["**/*.test.ts", "**/*.d.ts", "extensions/**/test-helpers.ts", "extensions/**/fixtures/**"],
    },
  },
});
