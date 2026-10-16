import { describe, expect, it } from "vitest";

import { buildRepoContext } from "./repo-context.js";

describe("buildRepoContext", () => {
  it("adds nothing to the prompt when no repo is registered", () => {
    expect(buildRepoContext([])).toBe("");
  });

  it("lists every repo, marking the root and any base branch", () => {
    expect(buildRepoContext([
      { path: "/work/app", isRoot: true, baseBranch: "main" },
      { path: "/work/lib", isRoot: false },
    ])).toBe("\nRegistered repositories:\n  - /work/app (root), base: main\n  - /work/lib\n");
  });
});
