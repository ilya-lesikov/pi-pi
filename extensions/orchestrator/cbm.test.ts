import { describe, it, expect, vi } from "vitest";
import { CbmDaemon } from "./cbm.js";

describe("CbmDaemon index tracking", () => {
  it("re-indexes a project after the daemon restarts (cleanup clears indexedProjects)", async () => {
    const daemon = new CbmDaemon();
    const indexCalls: string[] = [];

    const callTool = vi.spyOn(daemon, "callTool").mockImplementation(async (name, args) => {
      if (name === "list_projects") return { projects: [] };
      if (name === "index_repository") {
        indexCalls.push((args as { repo_path: string }).repo_path);
        return {};
      }
      return {};
    });

    const cwd = "/repo/project";

    await daemon.ensureIndexed(cwd);
    expect(indexCalls).toHaveLength(1);
    expect(daemon.hasIndexed(cwd)).toBe(true);

    await daemon.ensureIndexed(cwd);
    expect(indexCalls).toHaveLength(1);

    daemon.cleanup();
    expect(daemon.hasIndexed(cwd)).toBe(false);

    await daemon.ensureIndexed(cwd);
    expect(indexCalls).toHaveLength(2);

    callTool.mockRestore();
  });
});
