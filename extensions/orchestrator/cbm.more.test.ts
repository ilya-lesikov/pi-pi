import { describe, it, expect, vi, afterEach } from "vitest";
import { CbmDaemon, registerCbmTools } from "./cbm.js";

const CBM_BIN_KEY = Symbol.for("pi-pi:cbm-bin");
const CBM_DAEMON_KEY = Symbol.for("pi-pi:cbm-daemon");

function stubReady(daemon: CbmDaemon) {
  vi.spyOn(daemon as any, "ensureReady").mockResolvedValue(undefined);
}

describe("CbmDaemon.callTool JSON handling", () => {
  it("parses content text that is valid JSON into an object", async () => {
    const daemon = new CbmDaemon();
    stubReady(daemon);
    vi.spyOn(daemon as any, "rpc").mockResolvedValue({
      content: [{ type: "text", text: JSON.stringify({ hello: "world", n: 1 }) }],
    });

    const result = await daemon.callTool("search_graph", {});
    expect(result).toEqual({ hello: "world", n: 1 });
  });

  it("returns raw string when content text is not JSON", async () => {
    const daemon = new CbmDaemon();
    stubReady(daemon);
    vi.spyOn(daemon as any, "rpc").mockResolvedValue({
      content: [{ type: "text", text: "not json here" }],
    });

    const result = await daemon.callTool("search_graph", {});
    expect(result).toBe("not json here");
  });

  it("returns the raw result when there is no content text", async () => {
    const daemon = new CbmDaemon();
    stubReady(daemon);
    const raw = { something: true };
    vi.spyOn(daemon as any, "rpc").mockResolvedValue(raw);

    const result = await daemon.callTool("search_graph", {});
    expect(result).toBe(raw);
  });

  it("throws with the content text when result.isError is true", async () => {
    const daemon = new CbmDaemon();
    stubReady(daemon);
    vi.spyOn(daemon as any, "rpc").mockResolvedValue({
      isError: true,
      content: [{ type: "text", text: "boom failed" }],
    });

    await expect(daemon.callTool("search_graph", {})).rejects.toThrow("boom failed");
  });

  it("throws a fallback message when isError has no content text", async () => {
    const daemon = new CbmDaemon();
    stubReady(daemon);
    vi.spyOn(daemon as any, "rpc").mockResolvedValue({ isError: true });

    await expect(daemon.callTool("search_graph", {})).rejects.toThrow("unknown CBM error");
  });
});

describe("CbmDaemon.ensureIndexed", () => {
  it("skips index_repository when list_projects already contains the derived name", async () => {
    const daemon = new CbmDaemon();
    const indexCalls: string[] = [];
    vi.spyOn(daemon, "callTool").mockImplementation(async (name, args) => {
      if (name === "list_projects") return { projects: [{ name: "repo-foo-bar" }] };
      if (name === "index_repository") {
        indexCalls.push((args as { repo_path: string }).repo_path);
        return {};
      }
      return {};
    });

    const project = await daemon.ensureIndexed("/repo/foo/bar");
    expect(project).toBe("repo-foo-bar");
    expect(indexCalls).toHaveLength(0);
    expect(daemon.hasIndexed("/repo/foo/bar")).toBe(true);
  });

  it("falls through to index_repository when list_projects throws", async () => {
    const daemon = new CbmDaemon();
    const indexCalls: string[] = [];
    vi.spyOn(daemon, "callTool").mockImplementation(async (name, args) => {
      if (name === "list_projects") throw new Error("no daemon");
      if (name === "index_repository") {
        indexCalls.push((args as { repo_path: string }).repo_path);
        return {};
      }
      return {};
    });

    await daemon.ensureIndexed("/repo/foo/bar");
    expect(indexCalls).toEqual(["/repo/foo/bar"]);
    expect(daemon.hasIndexed("/repo/foo/bar")).toBe(true);
  });

  it("derives the project name by stripping the leading slash and replacing slashes with dashes", async () => {
    const daemon = new CbmDaemon();
    vi.spyOn(daemon, "callTool").mockImplementation(async (name) => {
      if (name === "list_projects") return { projects: [] };
      return {};
    });

    const project = await daemon.ensureIndexed("/repo/foo/bar");
    expect(project).toBe("repo-foo-bar");
  });
});

describe("registerCbmTools", () => {
  afterEach(() => {
    (globalThis as any)[CBM_BIN_KEY] = undefined;
    (globalThis as any)[CBM_DAEMON_KEY] = undefined;
    vi.restoreAllMocks();
  });

  function fakeDaemon(overrides: Partial<Record<"ensureIndexed" | "callTool", any>> = {}) {
    return {
      ensureIndexed: overrides.ensureIndexed ?? vi.fn().mockResolvedValue("repo-x"),
      callTool: overrides.callTool ?? vi.fn().mockResolvedValue({ result: "ok" }),
    };
  }

  // The bin path and daemon are cached on globalThis via Symbol.for; injecting them
  // avoids spawning a real `which` probe or child process.
  function forceAvailable(daemon: unknown) {
    (globalThis as any)[CBM_BIN_KEY] = "/fake/bin";
    (globalThis as any)[CBM_DAEMON_KEY] = daemon;
  }

  it("registers exactly 6 tools with expected names when the binary is available", () => {
    forceAvailable(fakeDaemon());
    const pi = { registerTool: vi.fn() } as any;

    const registered = registerCbmTools(pi, "/repo/x");
    expect(registered).toBe(true);
    expect(pi.registerTool).toHaveBeenCalledTimes(6);

    const names = pi.registerTool.mock.calls.map((c: any[]) => c[0].name);
    expect(names).toEqual([
      "cbm_search",
      "cbm_search_code",
      "cbm_trace",
      "cbm_changes",
      "cbm_query",
      "cbm_architecture",
    ]);
  });

  it("returns false and registers nothing when the binary is unavailable", () => {
    (globalThis as any)[CBM_BIN_KEY] = null;
    const pi = { registerTool: vi.fn() } as any;

    const registered = registerCbmTools(pi, "/repo/x");
    expect(registered).toBe(false);
    expect(pi.registerTool).not.toHaveBeenCalled();
  });

  function registerAndGetTools(daemon: unknown) {
    forceAvailable(daemon);
    const pi = { registerTool: vi.fn() } as any;
    registerCbmTools(pi, "/repo/x");
    const tools: Record<string, any> = {};
    for (const call of pi.registerTool.mock.calls) tools[call[0].name] = call[0];
    return tools;
  }

  it("cbm_search success passes query/name_pattern/semantic_query/label/limit and stringifies the result", async () => {
    const callTool = vi.fn().mockResolvedValue({ nodes: [1, 2] });
    const ensureIndexed = vi.fn().mockResolvedValue("repo-x");
    const tools = registerAndGetTools(fakeDaemon({ callTool, ensureIndexed }));

    const res = await tools.cbm_search.execute("id", {
      query: "q",
      name_pattern: "np",
      semantic_query: ["a", "b"],
      label: "Function",
      limit: 5,
    });

    expect(callTool).toHaveBeenCalledWith("search_graph", {
      project: "repo-x",
      limit: 5,
      query: "q",
      name_pattern: "np",
      semantic_query: ["a", "b"],
      label: "Function",
    });
    expect(res.isError).toBeUndefined();
    expect(res.content[0].text).toBe(JSON.stringify({ nodes: [1, 2] }, null, 2));
    expect(res.details).toEqual({});
  });

  it("cbm_search defaults limit to 20 and omits absent optional params", async () => {
    const callTool = vi.fn().mockResolvedValue({});
    const tools = registerAndGetTools(fakeDaemon({ callTool }));

    await tools.cbm_search.execute("id", {});
    expect(callTool).toHaveBeenCalledWith("search_graph", { project: "repo-x", limit: 20 });
  });

  it("cbm_search returns an error result when the daemon rejects", async () => {
    const callTool = vi.fn().mockRejectedValue(new Error("kaboom"));
    const tools = registerAndGetTools(fakeDaemon({ callTool }));

    const res = await tools.cbm_search.execute("id", { query: "q" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toBe("cbm_search error: kaboom");
  });

  it("cbm_search_code passes pattern/file_pattern/path_filter and maps tool name", async () => {
    const callTool = vi.fn().mockResolvedValue({});
    const tools = registerAndGetTools(fakeDaemon({ callTool }));

    await tools.cbm_search_code.execute("id", {
      pattern: "TODO",
      file_pattern: "*.go",
      path_filter: "^pkg/",
      limit: 3,
    });
    expect(callTool).toHaveBeenCalledWith("search_code", {
      project: "repo-x",
      pattern: "TODO",
      limit: 3,
      file_pattern: "*.go",
      path_filter: "^pkg/",
    });
  });

  it("cbm_search_code returns an error result when the daemon rejects", async () => {
    const callTool = vi.fn().mockRejectedValue(new Error("bad"));
    const tools = registerAndGetTools(fakeDaemon({ callTool }));

    const res = await tools.cbm_search_code.execute("id", { pattern: "x" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toBe("cbm_search_code error: bad");
  });

  it("cbm_trace defaults direction=both and depth=3", async () => {
    const callTool = vi.fn().mockResolvedValue({});
    const tools = registerAndGetTools(fakeDaemon({ callTool }));

    await tools.cbm_trace.execute("id", { function_name: "main" });
    expect(callTool).toHaveBeenCalledWith("trace_path", {
      project: "repo-x",
      function_name: "main",
      direction: "both",
      depth: 3,
    });
  });

  it("cbm_trace honours explicit direction and depth", async () => {
    const callTool = vi.fn().mockResolvedValue({});
    const tools = registerAndGetTools(fakeDaemon({ callTool }));

    await tools.cbm_trace.execute("id", { function_name: "main", direction: "inbound", depth: 5 });
    expect(callTool).toHaveBeenCalledWith("trace_path", {
      project: "repo-x",
      function_name: "main",
      direction: "inbound",
      depth: 5,
    });
  });

  it("cbm_trace returns an error result when the daemon rejects", async () => {
    const callTool = vi.fn().mockRejectedValue(new Error("trace fail"));
    const tools = registerAndGetTools(fakeDaemon({ callTool }));

    const res = await tools.cbm_trace.execute("id", { function_name: "x" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toBe("cbm_trace error: trace fail");
  });

  it("cbm_changes passes base_branch and since when present", async () => {
    const callTool = vi.fn().mockResolvedValue({});
    const tools = registerAndGetTools(fakeDaemon({ callTool }));

    await tools.cbm_changes.execute("id", { base_branch: "develop", since: "HEAD~5" });
    expect(callTool).toHaveBeenCalledWith("detect_changes", {
      project: "repo-x",
      base_branch: "develop",
      since: "HEAD~5",
    });
  });

  it("cbm_changes omits absent optional params", async () => {
    const callTool = vi.fn().mockResolvedValue({});
    const tools = registerAndGetTools(fakeDaemon({ callTool }));

    await tools.cbm_changes.execute("id", {});
    expect(callTool).toHaveBeenCalledWith("detect_changes", { project: "repo-x" });
  });

  it("cbm_changes returns an error result when the daemon rejects", async () => {
    const callTool = vi.fn().mockRejectedValue(new Error("chg"));
    const tools = registerAndGetTools(fakeDaemon({ callTool }));

    const res = await tools.cbm_changes.execute("id", {});
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toBe("cbm_changes error: chg");
  });

  it("cbm_query passes the cypher query through", async () => {
    const callTool = vi.fn().mockResolvedValue({});
    const tools = registerAndGetTools(fakeDaemon({ callTool }));

    await tools.cbm_query.execute("id", { query: "MATCH (n) RETURN n" });
    expect(callTool).toHaveBeenCalledWith("query_graph", {
      project: "repo-x",
      query: "MATCH (n) RETURN n",
    });
  });

  it("cbm_query returns an error result when the daemon rejects", async () => {
    const callTool = vi.fn().mockRejectedValue(new Error("q err"));
    const tools = registerAndGetTools(fakeDaemon({ callTool }));

    const res = await tools.cbm_query.execute("id", { query: "x" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toBe("cbm_query error: q err");
  });

  it("cbm_architecture calls get_architecture with the project", async () => {
    const callTool = vi.fn().mockResolvedValue({ nodes: 10 });
    const tools = registerAndGetTools(fakeDaemon({ callTool }));

    const res = await tools.cbm_architecture.execute("id", {});
    expect(callTool).toHaveBeenCalledWith("get_architecture", { project: "repo-x" });
    expect(res.content[0].text).toBe(JSON.stringify({ nodes: 10 }, null, 2));
  });

  it("cbm_architecture returns an error result when the daemon rejects", async () => {
    const callTool = vi.fn().mockRejectedValue(new Error("arch"));
    const tools = registerAndGetTools(fakeDaemon({ callTool }));

    const res = await tools.cbm_architecture.execute("id", {});
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toBe("cbm_architecture error: arch");
  });

  it("project_path overrides cwd in ensureIndexed", async () => {
    const ensureIndexed = vi.fn().mockResolvedValue("repo-other");
    const tools = registerAndGetTools(fakeDaemon({ ensureIndexed }));

    await tools.cbm_search.execute("id", { query: "q", project_path: "/other/repo" });
    expect(ensureIndexed).toHaveBeenCalledWith("/other/repo");
  });

  it("defaults ensureIndexed to the registration cwd when project_path is absent", async () => {
    const ensureIndexed = vi.fn().mockResolvedValue("repo-x");
    const tools = registerAndGetTools(fakeDaemon({ ensureIndexed }));

    await tools.cbm_search.execute("id", { query: "q" });
    expect(ensureIndexed).toHaveBeenCalledWith("/repo/x");
  });
});
