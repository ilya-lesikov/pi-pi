import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDefaultConfig } from "./config.js";
import {
  catalogModelsOf,
  catalogProviders,
  clearPauses,
  configureRouting,
  describePauseKey,
  describeRef,
  describeSpec,
  displayName,
  forgetLastGood,
  listCatalog,
  pause,
  pauseKeyForSpec,
  pinnedRoleSpecs,
  refLabel,
  resolveRef,
  routePauseKey,
  routingConfig,
  setCatalog,
  slotRefOfSpec,
  unpause,
  vendorOf,
} from "./routing.js";

const SUB_GATEWAY = "pp-flant-anthropic-sub/sub/claude-opus-5";
const SUB_DIRECT = "pp-claude-sub/claude-opus-5";
const COPILOT = "github-copilot/claude-opus-5";

function configure(mutate: (config: ReturnType<typeof getDefaultConfig>) => void = () => {}): void {
  const config = getDefaultConfig();
  mutate(config);
  configureRouting(config);
}

beforeEach(() => {
  clearPauses();
  forgetLastGood();
  configure();
});

afterEach(() => {
  clearPauses();
  forgetLastGood();
  setCatalog([]);
  configure();
});

describe("catalog", () => {
  it("drops -latest aliases, duplicates and malformed specs, grouping by provider", () => {
    setCatalog([" zai/glm-5.3 ", "zai/glm-5.3", "zai/glm-latest", "nonsense", "a/x", "zai/glm-5.3-flash"]);
    expect(listCatalog()).toEqual(["zai/glm-5.3", "a/x", "zai/glm-5.3-flash"]);
    expect(catalogProviders()).toEqual(["a", "zai"]);
    expect(catalogModelsOf("zai")).toEqual(["glm-5.3", "glm-5.3-flash"]);
    expect(catalogModelsOf("none")).toEqual([]);
  });

  it("keeps its own copy of the configured routing", () => {
    const config = getDefaultConfig();
    configureRouting(config);
    config.providers.order.reverse();
    expect(routingConfig().providers.order[0]).toBe("claude-sub");
  });
});

describe("references and labels", () => {
  it("lists only the role models pinned to an exact provider/model", () => {
    const config = getDefaultConfig();
    config.agents.main.model = "zai/glm-5.3";
    expect(pinnedRoleSpecs(config)).toEqual(["zai/glm-5.3"]);
    expect(pinnedRoleSpecs(null)).toEqual([]);
    expect(pinnedRoleSpecs({} as any)).toEqual([]);
  });

  it("labels slots, pro slots, pins and junk", () => {
    expect(refLabel("claude/opus")).toBe("Claude Opus");
    expect(refLabel("gpt/sol:pro")).toBe("GPT Sol Pro");
    expect(refLabel("zai/glm-5.3")).toBe("zai/glm-5.3");
    expect(refLabel("junk")).toBe("junk");
  });

  it("explains a reference that is neither a slot nor a model", () => {
    expect(resolveRef("junk")).toEqual({ ref: "junk", spec: null, via: null, proFallback: false, steps: ['✗ "junk" is neither a slot (e.g. claude/opus) nor provider/model'] });
  });

  it("names pause keys for accounts, routes, slots and anything else", () => {
    expect(describePauseKey("codex")).toBe("ChatGPT subscription");
    expect(describePauseKey(routePauseKey("direct"))).toBe("Claude subscription (direct)");
    expect(describePauseKey(routePauseKey("llm-api"))).toBe("Claude subscription (via LLM API)");
    expect(describePauseKey("copilot:claude/opus")).toBe("GitHub Copilot · Claude Opus");
    expect(describePauseKey("other:zai/glm")).toBe("other · zai/glm");
    expect(describePauseKey("plain")).toBe("plain");
  });

  it("pauses nothing for a model no provider routes", () => {
    expect(pauseKeyForSpec("junk")).toBeNull();
    expect(pauseKeyForSpec("zai/glm-5.3")).toBeNull();
    expect(pauseKeyForSpec("github-copilot/glm-5.3")).toBe("copilot:github-copilot/glm-5.3");
  });

  it("describes models by vendor, slot and override", () => {
    expect(vendorOf("junk")).toBe("unknown");
    expect(describeRef("zai/glm-5.3")).toMatchObject({ label: "glm-5.3", vendor: "zai", tier: "unknown" });
    expect(describeSpec("junk")).toMatchObject({ label: "junk", family: null });
    expect(displayName(describeSpec(COPILOT))).toBe("Claude Opus");
    configure((c) => { c.models.claude.override = { provider: "zai", model: "glm-5.3" }; });
    expect(displayName(describeSpec("zai/glm-5.3"))).toBe("Claude Fable · override zai/glm-5.3");
    // With the family overridden, a real Claude id no longer names its slot.
    expect(describeSpec(COPILOT)).toMatchObject({ family: null, tier: "smart" });
  });

  it("finds the slot a concrete model re-resolves through", () => {
    expect(slotRefOfSpec("pp-flant-openai/gpt-6-sol-pro")).toBe("gpt/sol:pro");
    expect(slotRefOfSpec(COPILOT)).toBe("claude/opus");
    expect(slotRefOfSpec("zai/glm-5.3")).toBeNull();
  });
});

describe("last working model", () => {
  function remember(spec: string) {
    setCatalog([spec]);
    expect(resolveRef("claude/opus").spec).toBe(spec);
  }

  it("keeps it while its provider is merely missing from the catalog's resolution", () => {
    remember(COPILOT);
    pause("copilot", 60_000, "test");
    // The copilot account pause is not the per-slot key, so last-good still holds it.
    expect(resolveRef("claude/opus")).toMatchObject({ spec: COPILOT, via: "last-good" });
  });

  it("drops it when its own pause key is paused", () => {
    remember(COPILOT);
    pause("copilot:claude/opus", 60_000, "test");
    expect(resolveRef("claude/opus").spec).toBeNull();
  });

  it("drops it when its provider is disabled or it belongs to another slot", () => {
    remember(COPILOT);
    configure((c) => { c.providers.copilot.enabled = false; });
    expect(resolveRef("claude/opus").spec).toBeNull();
    configure();
    remember(COPILOT);
    setCatalog([COPILOT]);
    configure((c) => { c.providers.order = ["claude-sub"]; c.providers.copilot.enabled = false; });
    expect(resolveRef("claude/opus").spec).toBeNull();
  });

  it("drops a subscription model whose route was removed or paused", () => {
    remember(SUB_GATEWAY);
    pause(routePauseKey("llm-api"), 60_000, "test");
    expect(resolveRef("claude/opus").spec).toBeNull();
    unpause(routePauseKey("llm-api"));
    clearPauses();
    remember(SUB_DIRECT);
    configure((c) => { c.providers["claude-sub"].route = ["llm-api"]; });
    expect(resolveRef("claude/opus").spec).toBeNull();
  });

  it("drops a model outside any provider", () => {
    setCatalog(["zai/claude-opus-5"]);
    configure((c) => { c.models.claude.override = { provider: "zai", model: "claude-opus-5" }; });
    expect(resolveRef("claude/opus").spec).toBe("zai/claude-opus-5");
    configure();
    expect(resolveRef("claude/opus").spec).toBeNull();
  });
});
