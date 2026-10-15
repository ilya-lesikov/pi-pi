import { describe, expect, it } from "vitest";

import { getAgentConfigSnapshot, getAgentDefinition, listAgentDefinitions, registerAgentDefinitions } from "./registry.js";

function fm(overrides: Partial<any> = {}) {
  return {
    description: "d",
    tools: "read, grep",
    model: "m",
    thinking: "low",
    max_turns: 5,
    ...overrides,
  };
}

describe("registerAgentDefinitions", () => {
  it("names a definition type_variant when a variant is present, else just type", () => {
    registerAgentDefinitions([
      { type: "planner", variant: "x", frontmatter: fm(), prompt: "p1" },
      { type: "planner", variant: null, frontmatter: fm(), prompt: "p2" },
    ]);
    expect(listAgentDefinitions().map((definition) => definition.name)).toEqual(["planner_x", "planner"]);
  });

  it("maps tools 'none' to no tools", () => {
    registerAgentDefinitions([{ type: "a", variant: null, frontmatter: fm({ tools: "none" }), prompt: "p" }]);
    expect(getAgentDefinition("a")?.tools).toEqual([]);
  });

  it("splits, trims and filters empty tool names", () => {
    registerAgentDefinitions([{ type: "a", variant: null, frontmatter: fm({ tools: "read, grep, bash, " }), prompt: "p" }]);
    expect(getAgentDefinition("a")?.tools).toEqual(["read", "grep", "bash"]);
  });

  it("keeps the registered model, thinking, turn limit and prompt", () => {
    registerAgentDefinitions([{ type: "planner", variant: null, frontmatter: fm({ ref: "claude/opus" }), prompt: "SYS" }]);
    expect(getAgentDefinition("planner")).toEqual({
      name: "planner",
      description: "d",
      tools: ["read", "grep"],
      model: "m",
      ref: "claude/opus",
      thinking: "low",
      maxTurns: 5,
      systemPrompt: "SYS",
    });
  });

  it("replaces the previous set, so a removed pool member stops resolving", () => {
    registerAgentDefinitions([{ type: "old", variant: null, frontmatter: fm(), prompt: "p" }]);
    registerAgentDefinitions([{ type: "new", variant: null, frontmatter: fm(), prompt: "p" }]);
    expect(getAgentDefinition("old")).toBeUndefined();
    expect(getAgentConfigSnapshot("old")).toBeUndefined();
    expect(getAgentDefinition("new")).toBeDefined();
  });

  it("records a model+thinking snapshot retrievable by agent name", () => {
    registerAgentDefinitions([
      { type: "planner", variant: "opus", frontmatter: fm({ model: "anthropic/claude-opus-latest", thinking: "high" }), prompt: "p" },
      { type: "code_reviewer", variant: "gpt", frontmatter: fm({ model: "openai/gpt-latest", thinking: "xhigh" }), prompt: "p" },
    ]);

    expect(getAgentConfigSnapshot("planner_opus")).toEqual({ model: "anthropic/claude-opus-latest", thinking: "high" });
    expect(getAgentConfigSnapshot("code_reviewer_gpt")).toEqual({ model: "openai/gpt-latest", thinking: "xhigh" });
    expect(getAgentConfigSnapshot("nonexistent")).toBeUndefined();
  });
});
