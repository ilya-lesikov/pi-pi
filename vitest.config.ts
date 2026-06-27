import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Several modules (logger, Flant, cbm daemon) use process-global state guarded
    // by globalThis symbols. Running test files in parallel within one worker lets
    // them clobber each other's global logger/streams, causing flaky empty-log reads.
    // The suite is small and fast, so run files serially for deterministic isolation.
    fileParallelism: false,
  },
});
