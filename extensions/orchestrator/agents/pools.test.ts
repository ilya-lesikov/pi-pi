import { describe, expect, it } from "vitest";
import { getDefaultConfig } from "../config.js";
import { encodePoolVariant, buildPoolRoster, registeredAgentNames, baseRoleForName } from "./registry.js";

describe("encodePoolVariant", () => {
  it("sanitizes the provider/model slash into a host-safe identifier", () => {
    const v = encodePoolVariant("pp-flant-anthropic-sub/sub/claude-opus-4-8", "high");
    expect(v).toBe("pp-flant-anthropic-sub-sub-claude-opus-4-8_high");
    expect(v).toMatch(/^[A-Za-z0-9._-]+$/);
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

describe("baseRoleForName", () => {
  it("maps dynamic pool names back to their base role", () => {
    expect(baseRoleForName("advisor_anthropic-claude-fable-latest_high")).toBe("advisor");
    expect(baseRoleForName("reviewer_openai-gpt-latest_high")).toBe("reviewer");
    expect(baseRoleForName("deep-debugger_openai-gpt-latest_high")).toBe("deep-debugger");
    expect(baseRoleForName("explore")).toBe("explore");
  });
});
