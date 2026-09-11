// The Agent tool description mode is fixed at "full" in pi-pi: subagents.json
// is no longer loaded (file-based configuration is disabled), so a
// `toolDescriptionMode` override in that file must have no effect. This guards
// against the config path being silently reconnected.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import subagentsExtension from "../src/index.js";

function makePi() {
  const tools = new Map<string, any>();
  const handlers = new Map<string, any>();

  return {
    pi: {
      registerMessageRenderer: vi.fn(),
      registerTool: vi.fn((tool: any) => {
        tools.set(tool.name, tool);
      }),
      registerCommand: vi.fn(),
      on: vi.fn((event: string, handler: any) => {
        handlers.set(event, handler);
      }),
      events: {
        emit: vi.fn(),
        on: vi.fn((event: string, handler: any) => {
          handlers.set(`evt:${event}`, handler);
          return vi.fn();
        }),
      },
      appendEntry: vi.fn(),
      sendMessage: vi.fn(),
    } as any,
    tools,
    handlers,
  };
}

describe("toolDescriptionMode", () => {
  let tmpDir: string;
  let hermeticAgentDir: string;
  let prevCwd: string;
  let prevAgentDir: string | undefined;
  let prevHome: string | undefined;
  let shutdown: (() => Promise<void>) | undefined;

  function setup(settings?: Record<string, unknown>) {
    tmpDir = mkdtempSync(join(tmpdir(), "pi-tooldesc-"));
    hermeticAgentDir = mkdtempSync(join(tmpdir(), "pi-tooldesc-agentdir-"));
    prevAgentDir = process.env.PI_CODING_AGENT_DIR;
    prevHome = process.env.HOME;
    process.env.PI_CODING_AGENT_DIR = hermeticAgentDir;
    process.env.HOME = hermeticAgentDir;
    prevCwd = process.cwd();
    mkdirSync(join(tmpDir, ".pi"), { recursive: true });
    if (settings) {
      writeFileSync(join(tmpDir, ".pi", "subagents.json"), JSON.stringify(settings));
    }
    process.chdir(tmpDir);

    const { pi, tools, handlers } = makePi();
    subagentsExtension(pi);
    shutdown = async () => {
      await handlers.get("session_shutdown")?.({}, { hasUI: false, ui: {} } as any);
    };
    return { tools, handlers };
  }

  afterEach(async () => {
    await shutdown?.();
    shutdown = undefined;
    process.chdir(prevCwd);
    if (prevAgentDir == null) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    if (prevHome == null) delete process.env.HOME;
    else process.env.HOME = prevHome;
    rmSync(tmpDir, { recursive: true, force: true });
    rmSync(hermeticAgentDir, { recursive: true, force: true });
  });

  it("defaults to the full description", () => {
    const { tools } = setup();
    const desc: string = tools.get("Agent").description;
    expect(desc).toContain("## Usage notes");
    expect(desc).toContain("## Writing the prompt");
    expect(desc).toContain("very thorough");
  });

  it("ignores a toolDescriptionMode override in subagents.json (file config disabled)", () => {
    const { tools } = setup({ toolDescriptionMode: "compact" });
    const desc: string = tools.get("Agent").description;
    // Still the full description — the file was not consulted.
    expect(desc).toContain("## Usage notes");
    expect(desc).toContain("## Writing the prompt");
  });

  it("refreshes the subagent_type description in place when dynamic agents register", () => {
    const { tools, handlers } = setup();
    const params = tools.get("Agent").parameters;
    const schema = params.properties.subagent_type;
    expect(schema.description).not.toContain("advisor_pp-flant");
    // A sibling extension registers a dynamic model-named pool agent.
    const registerHandler = handlers.get("evt:subagents:register-agents");
    expect(registerHandler).toBeDefined();
    const agents = new Map<string, any>([
      ["advisor_pp-flant-anthropic-sub_sub-claude-fable-5_high", { description: "advisor", model: "x", enabled: true }],
    ]);
    registerHandler({ agents });
    // Same schema object, description mutated in place to include the new type.
    expect(tools.get("Agent").parameters.properties.subagent_type).toBe(schema);
    expect(schema.description).toContain("advisor_pp-flant-anthropic-sub_sub-claude-fable-5_high");
  });

  // LOCAL PATCH (pi-pi): in extension-only mode the host extension pins each
  // agent type's model and effort, and an agent config's model outranks the
  // tool call's own argument, so the two parameters must stop advertising a
  // choice the caller does not have.
  it("drops the model and thinking guidance once a host extension takes over the roster", () => {
    const { tools, handlers } = setup();
    expect(tools.get("Agent").description).toContain("- Use model to specify a different model");
    expect(tools.get("Agent").parameters.properties.model.description).toContain("Optional model override");

    handlers.get("evt:subagents:set-extension-only")({ enabled: true });
    const pinned = tools.get("Agent");
    expect(pinned.description).not.toContain("- Use model to specify a different model");
    expect(pinned.description).not.toContain("- Use thinking to control extended thinking level");
    expect(pinned.description).toContain("## Usage notes");
    expect(pinned.parameters.properties.model.description).toContain("the agent type fixes this");
    expect(pinned.parameters.properties.thinking.description).toContain("the agent type fixes this");

    handlers.get("evt:subagents:set-extension-only")({ enabled: false });
    expect(tools.get("Agent").description).toContain("- Use model to specify a different model");
    expect(tools.get("Agent").parameters.properties.model.description).toContain("Optional model override");
  });
});
