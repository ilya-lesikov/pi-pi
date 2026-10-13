import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDefaultConfig } from "./config.js";
import {
  clearPauses,
  configureRouting,
  describeRef,
  describeSpec,
  displayName,
  forgetLastGood,
  isPaused,
  nextPauseMs,
  parseRef,
  pause,
  pauseKeyForSpec,
  poolToken,
  refusalFallbackSpec,
  resolveRef,
  resolveSpec,
  routePauseKey,
  setCatalog,
  slotOfPoolToken,
  vendorOf,
} from "./routing.js";

const CATALOG = [
  "pp-flant-anthropic-sub/sub/claude-opus-5",
  "pp-flant-anthropic-sub/sub/claude-opus-5-5",
  "pp-flant-anthropic-sub/sub/claude-fable-5-1",
  "pp-claude-sub/claude-opus-5-5",
  "pp-claude-sub/claude-fable-5-1",
  "github-copilot/claude-opus-5",
  "github-copilot/claude-fable-5.1",
  "github-copilot/gpt-6-astra",
  "openai-codex/gpt-6-astra",
  "openai-codex/gpt-6-sol",
  "openai-codex/gpt-5.6-luna",
  "pp-flant-openai/gpt-6-astra",
  "pp-flant-openai/gpt-6-astra-pro",
  "pp-flant-openai/gpt-6-sol-pro",
  "pp-flant-openai/gpt-6-sol",
  "pp-flant-openai/z-ai/glm-5.3",
  "zai/glm-5.3",
  "zai/glm-5.3-flash",
];

function configure(mutate: (config: ReturnType<typeof getDefaultConfig>) => void = () => {}): void {
  const config = getDefaultConfig();
  mutate(config);
  configureRouting(config);
}

beforeEach(() => {
  clearPauses();
  forgetLastGood();
  setCatalog(CATALOG);
  configure();
});

afterEach(() => {
  clearPauses();
});

describe("references", () => {
  it("parses slots, pro variants and raw pins", () => {
    expect(parseRef("claude/opus")).toEqual({ kind: "slot", family: "claude", slot: "opus", pro: false });
    expect(parseRef("gpt/astra:pro")).toEqual({ kind: "slot", family: "gpt", slot: "astra", pro: true });
    expect(parseRef("zai/glm-5.3")).toEqual({ kind: "pin", spec: "zai/glm-5.3" });
    // Pro is a GPT effort mode; Claude has none, and a slot from the other family is no slot.
    expect(parseRef("claude/opus:pro")).toBeNull();
    expect(parseRef("claude/astra")).toBeNull();
    expect(parseRef("nonsense")).toBeNull();
  });
});

describe("slot resolution", () => {
  it("serves a slot from the first enabled provider in priority order that has it", () => {
    expect(resolveSpec("claude/opus")).toBe("pp-flant-anthropic-sub/sub/claude-opus-5-5");
    expect(resolveSpec("gpt/astra")).toBe("openai-codex/gpt-6-astra");
  });

  it("follows a reordered priority list", () => {
    configure((c) => { c.providers.order = ["copilot", "claude-sub", "codex", "llm-api"]; });
    expect(resolveSpec("claude/opus")).toBe("github-copilot/claude-opus-5");
    expect(resolveSpec("gpt/astra")).toBe("github-copilot/gpt-6-astra");
  });

  it("takes the subscription's routes in their configured order", () => {
    configure((c) => { c.providers["claude-sub"].route = ["direct", "llm-api"]; });
    expect(resolveSpec("claude/opus")).toBe("pp-claude-sub/claude-opus-5-5");
  });

  it("skips a disabled provider", () => {
    configure((c) => { c.providers.codex.enabled = false; });
    expect(resolveSpec("gpt/astra")).toBe("github-copilot/gpt-6-astra");
  });

  it("uses the -pro variant only where one exists, and says when it fell back to base", () => {
    const viaApi = resolveRef("gpt/astra:pro");
    expect(viaApi.spec).toBe("openai-codex/gpt-6-astra");
    expect(viaApi.proFallback).toBe(true);
    configure((c) => { c.providers.order = ["llm-api", "claude-sub", "codex", "copilot"]; });
    expect(resolveRef("gpt/astra:pro")).toMatchObject({ spec: "pp-flant-openai/gpt-6-astra-pro", proFallback: false });
  });

  it("never picks a -pro model for a base slot", () => {
    configure((c) => { c.providers.order = ["llm-api", "claude-sub", "codex", "copilot"]; });
    expect(resolveSpec("gpt/sol")).toBe("pp-flant-openai/gpt-6-sol");
  });

  it("honors a version pin across catalogs that spell versions differently", () => {
    configure((c) => {
      c.providers.order = ["copilot", "claude-sub", "codex", "llm-api"];
      c.models.claude.pins = { fable: "claude-fable-5-1" };
    });
    expect(resolveSpec("claude/fable")).toBe("github-copilot/claude-fable-5.1");
  });

  it("never falls back to a weaker slot, and explains why nothing served it", () => {
    configure((c) => { c.models.claude.pins = { opus: "claude-opus-9" }; });
    const resolution = resolveRef("claude/opus");
    expect(resolution.spec).toBeNull();
    expect(resolution.steps.join("\n")).toMatch(/no claude-opus-9 model for Claude Opus/);
  });

  it("returns a raw pin as is, and nothing when it is not available", () => {
    expect(resolveRef("zai/glm-5.3")).toMatchObject({ spec: "zai/glm-5.3", via: "pin" });
    expect(resolveRef("kimi-coding/kimi-k3").spec).toBeNull();
  });
});

describe("family override", () => {
  it("maps every slot onto the override provider, with per-slot refinement", () => {
    configure((c) => { c.models.claude.override = { provider: "zai", model: "glm-5.3", slots: { haiku: "glm-5.3-flash" } }; });
    expect(resolveRef("claude/opus")).toMatchObject({ spec: "zai/glm-5.3", via: "override" });
    expect(resolveSpec("claude/haiku")).toBe("zai/glm-5.3-flash");
    expect(resolveSpec("gpt/astra")).toBe("openai-codex/gpt-6-astra");
  });

  it("does not fall back to another provider when the override is unavailable", () => {
    configure((c) => { c.models.claude.override = { provider: "kimi-coding", model: "kimi-k3" }; });
    const resolution = resolveRef("claude/opus");
    expect(resolution.spec).toBeNull();
    expect(resolution.steps.join("\n")).toMatch(/no credentials for kimi-coding/);
  });

  it("describes the slot with the override behind it", () => {
    configure((c) => { c.models.claude.override = { provider: "zai", model: "glm-5.3" }; });
    const description = describeRef("claude/opus");
    expect(description).toMatchObject({ label: "Claude Opus", tier: "smart", vendor: "zai", overridden: true, spec: "zai/glm-5.3" });
    expect(displayName(description)).toBe("Claude Opus · override zai/glm-5.3");
    // The default model fills every slot; seen without a role, it is described by the strongest.
    expect(describeSpec("zai/glm-5.3").label).toBe("Claude Fable");
  });
});

describe("vendors", () => {
  it("knows Claude and GPT by id, others by namespace or a first-party provider", () => {
    expect(vendorOf("github-copilot/claude-opus-5")).toBe("anthropic");
    expect(vendorOf("pp-flant-openai/gpt-6-astra")).toBe("openai");
    expect(vendorOf("pp-flant-openai/z-ai/glm-5.3")).toBe("z-ai");
    expect(vendorOf("zai/glm-5.3")).toBe("zai");
    expect(vendorOf("pp-flant-openai/kimi-k3")).toBe("unknown");
  });

  it("refuses a refusal fallback that does not leave the vendor", () => {
    expect(refusalFallbackSpec("pp-flant-anthropic-sub/sub/claude-opus-5-5")).toBe("openai-codex/gpt-6-sol");
    expect(refusalFallbackSpec("openai-codex/gpt-6-astra")).toBeNull();
  });
});

describe("pauses", () => {
  it("pauses a subscription account as a whole and other providers per slot", () => {
    expect(pauseKeyForSpec("pp-claude-sub/claude-opus-5-5")).toBe("claude-sub");
    expect(pauseKeyForSpec("pp-flant-anthropic-sub/sub/claude-fable-5-1")).toBe("claude-sub");
    expect(pauseKeyForSpec("openai-codex/gpt-6-sol")).toBe("codex");
    expect(pauseKeyForSpec("github-copilot/claude-opus-5")).toBe("copilot:claude/opus");
    expect(pauseKeyForSpec("pp-flant-openai/gpt-6-astra-pro")).toBe("llm-api:gpt/astra");
    expect(pauseKeyForSpec("zai/glm-5.3")).toBeNull();
  });

  it("routes around a paused provider and comes back when it expires", () => {
    pause("claude-sub", 60_000, "test");
    expect(resolveSpec("claude/opus")).toBe("github-copilot/claude-opus-5");
    clearPauses();
    expect(resolveSpec("claude/opus")).toBe("pp-flant-anthropic-sub/sub/claude-opus-5-5");
  });

  it("drops only the failing route of the subscription", () => {
    pause(routePauseKey("llm-api"), 60_000, "outage");
    expect(resolveSpec("claude/opus")).toBe("pp-claude-sub/claude-opus-5-5");
  });

  it("lets a pause lapse on its own", () => {
    pause("codex", -1, "test");
    expect(isPaused("codex")).toBe(false);
  });

  it("doubles the next pause during a streak, and follows a provider's hint", () => {
    expect(nextPauseMs("copilot:claude/opus", 10)).toBe(600_000);
    pause("copilot:claude/opus", 1, "test");
    expect(nextPauseMs("copilot:claude/opus", 10)).toBe(1_200_000);
    expect(nextPauseMs("copilot:claude/opus", 10, 90_000)).toBe(90_000);
  });

  it("keeps the last working model when nothing serves a slot, unless it is itself unusable", () => {
    expect(resolveSpec("gpt/sol")).toBe("openai-codex/gpt-6-sol");
    setCatalog(CATALOG.filter((s) => !s.includes("gpt-6-sol")));
    expect(resolveRef("gpt/sol").spec).toBeNull();
    setCatalog(CATALOG);
    expect(resolveSpec("gpt/sol")).toBe("openai-codex/gpt-6-sol");
    configure((c) => { c.providers.order = ["codex"]; c.providers["llm-api"].enabled = false; });
    configure((c) => { c.providers.codex.enabled = false; c.providers["llm-api"].enabled = false; });
    expect(resolveRef("gpt/sol").spec).toBeNull();
  });
});

describe("last working model", () => {
  it("does not outlive a change of override or version pin", () => {
    configure((c) => { c.providers.order = ["copilot", "claude-sub", "codex", "llm-api"]; });
    expect(resolveSpec("claude/opus")).toBe("github-copilot/claude-opus-5");
    configure((c) => {
      c.providers.order = ["copilot", "claude-sub", "codex", "llm-api"];
      c.models.claude.override = { provider: "kimi-coding", model: "kimi-k3" };
    });
    expect(resolveRef("claude/opus").spec).toBeNull();
    configure((c) => {
      c.providers.order = ["copilot", "claude-sub", "codex", "llm-api"];
      c.models.claude.pins = { opus: "claude-opus-9" };
    });
    expect(resolveRef("claude/opus").spec).toBeNull();
  });
});

describe("pool names", () => {
  it("names a pool member by slot, and maps an older version-bearing name back to it", () => {
    expect(poolToken("gpt/astra:pro")).toBe("gpt-astra-pro");
    expect(poolToken("claude/fable")).toBe("claude-fable");
    expect(poolToken("zai/glm-5.3")).toBe("glm-5-3");
    expect(slotOfPoolToken("claude-fable")).toBe("claude/fable");
    expect(slotOfPoolToken("claude-fable-5-1")).toBe("claude/fable");
    expect(slotOfPoolToken("gpt-6-astra-pro")).toBe("gpt/astra:pro");
    expect(slotOfPoolToken("pp-flant-anthropic-sub-sub-claude-fable-5-1")).toBe("claude/fable");
  });
});
