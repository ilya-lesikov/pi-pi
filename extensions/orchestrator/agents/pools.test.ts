import { describe, expect, it } from "vitest";
import { getDefaultConfig } from "../config.js";
import { updateRegistryFromAvailableModels } from "../model-registry.js";
import { encodePoolVariant, buildPoolRoster, registeredAgentNames, baseRoleForName, remapPoolName } from "./registry.js";

describe("encodePoolVariant", () => {
  it("keeps the model id and version but drops the provider, so a tier move never renames an agent", () => {
    const v = encodePoolVariant("pp-flant-anthropic-sub/sub/claude-opus-4-8", "high");
    expect(v).toBe("claude-opus-4-8_high");
    expect(v).toMatch(/^[A-Za-z0-9._-]+$/);
    expect(encodePoolVariant("github-copilot/claude-opus-4.8", "high")).toBe(v);
    expect(encodePoolVariant("pp-flant-anthropic/claude-opus-4-8", "high")).toBe(v);
  });

  it("keeps distinct SKUs of one family distinct", () => {
    expect(encodePoolVariant("pp-flant-openai/gpt-6-astra-pro", "high")).toBe("gpt-6-astra-pro_high");
    expect(encodePoolVariant("pp-flant-openai/gpt-6-astra", "high")).toBe("gpt-6-astra_high");
  });

  it("is deterministic", () => {
    expect(encodePoolVariant("anthropic/claude-fable-latest", "xhigh")).toBe(
      encodePoolVariant("anthropic/claude-fable-latest", "xhigh"),
    );
  });
});

describe("buildPoolRoster", () => {
  it("includes only enabled entries with model metadata and encoded names", () => {
    const config = getDefaultConfig();
    const roster = buildPoolRoster(config, "advisors");
    // default advisors: fable (enabled), gpt (enabled), gemini (disabled)
    expect(roster.length).toBe(2);
    expect(roster.every((r) => r.name.startsWith("advisor_"))).toBe(true);
    const fable = roster.find((r) => r.family === "fable");
    expect(fable).toBeTruthy();
    expect(fable!.tier).toBe("xsmart");
    expect(roster.some((r) => r.family === "gpt")).toBe(true);
    expect(roster.some((r) => r.family === "gemini-pro")).toBe(false);
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
  const flantConfig = () => {
    const config = getDefaultConfig();
    config.agents.subagents.pools.reviewers = [
      { enabled: true, model: "pp-flant-openai/gpt-6-astra-pro", thinking: "high" },
      { enabled: true, model: "pp-flant-anthropic-sub/sub/claude-fable-5-1", thinking: "high" },
    ];
    return config;
  };

  it("resolves a name that still spells out the provider it used to route through", () => {
    updateRegistryFromAvailableModels([
      "pp-flant-anthropic-sub/sub/claude-fable-5-1",
      "github-copilot/claude-fable-5.1",
      "pp-flant-openai/gpt-6-astra-pro",
    ]);
    expect(remapPoolName(flantConfig(), "reviewer_github-copilot-claude-fable-5-1_high"))
      .toBe("reviewer_claude-fable-5-1_high");
    expect(remapPoolName(flantConfig(), "reviewer_pp-flant-anthropic-sub-sub-claude-fable-5-1_high"))
      .toBe("reviewer_claude-fable-5-1_high");
  });

  it("resolves a superseded version onto the family's live member", () => {
    updateRegistryFromAvailableModels(["pp-flant-openai/gpt-6-astra-pro"]);
    expect(remapPoolName(flantConfig(), "reviewer_gpt-5-6-astra-pro_high"))
      .toBe("reviewer_gpt-6-astra-pro_high");
  });

  it("stays within the requested pool", () => {
    const config = flantConfig();
    config.agents.subagents.pools.advisors = [
      { enabled: true, model: "pp-flant-anthropic-sub/sub/claude-fable-5-1", thinking: "xhigh" },
    ];
    expect(remapPoolName(config, "advisor_claude-fable-4-5_high")).toBe("advisor_claude-fable-5-1_xhigh");
  });

  it("answers a lost effort level with the nearest one above it", () => {
    const config = flantConfig();
    config.agents.subagents.pools.advisors = [
      { enabled: true, model: "pp-flant-anthropic-sub/sub/claude-fable-5-1", thinking: "low" },
      { enabled: true, model: "pp-flant-anthropic-sub/sub/claude-fable-5-1", thinking: "xhigh" },
    ];
    expect(remapPoolName(config, "advisor_claude-fable-5-1_high")).toBe("advisor_claude-fable-5-1_xhigh");
  });

  it("refuses a family the pool does not serve, an unknown model, and a non-pool name", () => {
    const config = flantConfig();
    config.agents.subagents.pools.reviewers = [
      { enabled: true, model: "pp-flant-openai/gpt-6-astra-pro", thinking: "high" },
    ];
    expect(remapPoolName(config, "reviewer_claude-fable-5-1_high")).toBeNull();
    expect(remapPoolName(config, "reviewer_not-a-model_high")).toBeNull();
    expect(remapPoolName(config, "task")).toBeNull();
    expect(remapPoolName(config, "reviewer")).toBeNull();
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
