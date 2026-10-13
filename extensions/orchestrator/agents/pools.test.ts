import { beforeEach, describe, expect, it } from "vitest";
import { getDefaultConfig } from "../config.js";
import { configureRouting, setCatalog } from "../routing.js";
import { encodePoolVariant, buildPoolRoster, registeredAgentNames, baseRoleForName, remapPoolName } from "./registry.js";

beforeEach(() => {
  configureRouting(getDefaultConfig());
  setCatalog([
    "pp-flant-anthropic-sub/sub/claude-fable-5-1",
    "github-copilot/claude-fable-5.1",
    "pp-flant-openai/gpt-6-astra-pro",
    "openai-codex/gpt-6-astra",
  ]);
});

describe("encodePoolVariant", () => {
  // The provider and the version are what a rate limit or a release moves; a
  // name that carried them would be renamed under a model holding it mid-turn.
  it("names a member by its slot, so neither a provider move nor a new version renames it", () => {
    expect(encodePoolVariant("claude/fable", "high")).toBe("claude-fable_high");
    expect(encodePoolVariant("gpt/astra:pro", "high")).toBe("gpt-astra-pro_high");
    expect(encodePoolVariant("gpt/astra", "high")).toBe("gpt-astra_high");
  });

  it("names a pinned member by its model id", () => {
    expect(encodePoolVariant("zai/glm-5.3", "high")).toBe("glm-5-3_high");
    expect(encodePoolVariant("zai/glm-5.3", "high")).toMatch(/^[A-Za-z0-9._-]+$/);
  });
});

describe("buildPoolRoster", () => {
  it("includes only enabled entries, with what each routes to now", () => {
    const config = getDefaultConfig();
    config.agents.subagents.pools.advisors.push({ enabled: false, model: "claude/opus", thinking: "high" });
    const roster = buildPoolRoster(config, "advisors");
    expect(roster.map((r) => r.name)).toEqual(["advisor_gpt-astra-pro_high", "advisor_claude-fable_high"]);
    const fable = roster.find((r) => r.ref === "claude/fable")!;
    expect(fable.description).toMatchObject({ label: "Claude Fable", tier: "xsmart", vendor: "anthropic" });
    expect(fable.model).toBe("pp-flant-anthropic-sub/sub/claude-fable-5-1");
    const astra = roster.find((r) => r.ref === "gpt/astra:pro")!;
    expect(astra.model).toBe("openai-codex/gpt-6-astra");
    expect(astra.proFallback).toBe(true);
  });
});

describe("registeredAgentNames", () => {
  it("lists the fixed simple roles plus every enabled pool member", () => {
    const names = registeredAgentNames(getDefaultConfig());
    expect(names).toContain("explore");
    expect(names).toContain("librarian");
    expect(names).toContain("task");
    expect(names.some((n) => n.startsWith("advisor_"))).toBe(true);
    expect(names.some((n) => n.startsWith("reviewer_"))).toBe(true);
    expect(names.some((n) => n.startsWith("deep-debugger_"))).toBe(true);
    // No stale fixed advisor/advisor2/advisor3 role names.
    expect(names).not.toContain("advisor");
    expect(names).not.toContain("advisor2");
  });
});

describe("remapPoolName", () => {
  const config = () => getDefaultConfig();

  it("maps a name an older build gave a member, version and provider included, onto its slot", () => {
    expect(remapPoolName(config(), "reviewer_claude-fable-5-1_high")).toBe("reviewer_claude-fable_high");
    expect(remapPoolName(config(), "reviewer_pp-flant-anthropic-sub-sub-claude-fable-5-1_high")).toBe("reviewer_claude-fable_high");
    expect(remapPoolName(config(), "reviewer_gpt-6-astra-pro_high")).toBe("reviewer_gpt-astra-pro_high");
  });

  it("accepts a base name for a pro member when the pool has only that", () => {
    expect(remapPoolName(config(), "advisor_gpt-astra_high")).toBe("advisor_gpt-astra-pro_high");
  });

  it("answers a lost effort level with the nearest one above it", () => {
    const c = config();
    c.agents.subagents.pools.advisors = [
      { enabled: true, model: "claude/fable", thinking: "low" },
      { enabled: true, model: "claude/fable", thinking: "xhigh" },
    ];
    expect(remapPoolName(c, "advisor_claude-fable_high")).toBe("advisor_claude-fable_xhigh");
  });

  it("refuses a slot the pool does not serve, an unknown model, and a non-pool name", () => {
    const c = config();
    c.agents.subagents.pools.reviewers = [{ enabled: true, model: "gpt/astra:pro", thinking: "high" }];
    expect(remapPoolName(c, "reviewer_claude-fable_high")).toBeNull();
    expect(remapPoolName(c, "reviewer_not-a-model_high")).toBeNull();
    expect(remapPoolName(c, "task")).toBeNull();
    expect(remapPoolName(c, "reviewer")).toBeNull();
  });
});

describe("baseRoleForName", () => {
  it("maps dynamic pool names back to their base role", () => {
    expect(baseRoleForName("advisor_anthropic-claude-fable-latest_high")).toBe("advisor");
    expect(baseRoleForName("reviewer_openai-gpt-latest_high")).toBe("reviewer");
    expect(baseRoleForName("deep-debugger_openai-gpt-latest_high")).toBe("deep-debugger");
    expect(baseRoleForName("explore")).toBe("explore");
  });
});
