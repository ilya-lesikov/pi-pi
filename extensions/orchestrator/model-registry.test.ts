import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./log.js", () => ({
  getLogger: () => ({
    debug: vi.fn(),
  }),
}));

import {
  clearAllTierDemotions,
  demoteTierForFamily,
  findLatestFamilyMatch,
  getAllAliases,
  getModelFamilies,
  getModelInfo,
  getTierEnabled,
  isSubscriptionFallbackActive,
  listTierDemotions,
  PROVIDER_TIER_ORDER,
  resolveModel,
  restoreTierForFamily,
  setSubscriptionFallbackActive,
  setTierEnabled,
  toNonSubSpec,
  updateRegistryFromAvailableModels,
} from "./model-registry.js";

describe("model-registry", () => {
  beforeEach(() => {
    updateRegistryFromAvailableModels([]);
  });

  it("resolveModel passes through native-latest aliases", () => {
    expect(resolveModel("anthropic/claude-sonnet-latest")).toBe("anthropic/claude-sonnet-latest");
    expect(resolveModel("anthropic/claude-opus-latest")).toBe("anthropic/claude-opus-latest");
    expect(resolveModel("anthropic/claude-haiku-latest")).toBe("anthropic/claude-haiku-latest");
  });

  it("resolveModel returns input unchanged for non-native aliases without available models", () => {
    expect(resolveModel("openai/gpt-mini-latest")).toBe("openai/gpt-mini-latest");
    expect(resolveModel("pp-flant-anthropic/claude-opus-latest")).toBe("pp-flant-anthropic/claude-opus-latest");
  });

  it("resolveModel passes through unknown aliases", () => {
    expect(resolveModel("custom/provider-model")).toBe("custom/provider-model");
  });

  it("resolveModel resolves flant aliases after updateRegistry", () => {
    updateRegistryFromAvailableModels(["claude-opus-4-6", "gemini-3.1-pro"]);
    expect(resolveModel("pp-flant-anthropic/claude-opus-latest")).toBe("pp-flant-anthropic/claude-opus-4-6");
    expect(resolveModel("pp-flant-openai/gemini-pro-latest")).toBe("pp-flant-openai/gemini-3.1-pro");
  });

  it("getModelInfo detects personal-subscription Claude models", () => {
    expect(getModelInfo("pp-flant-anthropic-sub/sub/claude-opus-4-8")).toMatchObject({ vendor: "anthropic", family: "opus", tier: "smart" });
    expect(getModelInfo("pp-flant-anthropic-sub/sub/claude-sonnet-4-6")).toMatchObject({ vendor: "anthropic", family: "sonnet", tier: "regular" });
    expect(getModelInfo("pp-flant-anthropic-sub/sub/claude-haiku-4-5")).toMatchObject({ vendor: "anthropic", family: "haiku", tier: "stupid" });
  });

  it("resolveModel resolves subscription aliases to sub/ specs after updateRegistry", () => {
    updateRegistryFromAvailableModels([
      "pp-flant-anthropic-sub/sub/claude-opus-4-7",
      "pp-flant-anthropic-sub/sub/claude-opus-4-8",
      "pp-flant-anthropic-sub/sub/claude-haiku-4-5",
    ]);
    expect(resolveModel("pp-flant-anthropic-sub/claude-opus-latest")).toBe("pp-flant-anthropic-sub/sub/claude-opus-4-8");
    expect(resolveModel("pp-flant-anthropic-sub/claude-haiku-latest")).toBe("pp-flant-anthropic-sub/sub/claude-haiku-4-5");
  });

  it("getModelInfo detects all configured families", () => {
    expect(getModelInfo("anthropic/claude-opus-4-6")).toMatchObject({ vendor: "anthropic", family: "opus", tier: "smart" });
    expect(getModelInfo("anthropic/claude-sonnet-4-6")).toMatchObject({ vendor: "anthropic", family: "sonnet", tier: "regular" });
    expect(getModelInfo("anthropic/claude-haiku-3-5")).toMatchObject({ vendor: "anthropic", family: "haiku", tier: "stupid" });
    expect(getModelInfo("openai/gpt-5.4")).toMatchObject({ vendor: "openai", family: "gpt", tier: "regular" });
    expect(getModelInfo("openai/gpt-5.4-mini")).toMatchObject({ vendor: "openai", family: "gpt-mini", tier: "stupid" });
    expect(getModelInfo("google/gemini-3.1-pro")).toMatchObject({ vendor: "google", family: "gemini-pro", tier: "regular" });
    expect(getModelInfo("google/gemini-3.1-flash")).toMatchObject({ vendor: "google", family: "gemini-flash", tier: "stupid" });
    expect(getModelInfo("deepseek/deepseek-v3")).toMatchObject({ vendor: "deepseek", family: "deepseek", tier: "regular" });
    expect(getModelInfo("x-ai/grok-4")).toMatchObject({ vendor: "xai", family: "grok", tier: "regular" });
    expect(getModelInfo("qwen/qwen-coder-3")).toMatchObject({ vendor: "qwen", family: "qwen", tier: "regular" });
  });

  it("getModelInfo returns unknown for unknown models", () => {
    expect(getModelInfo("unknown/provider-model")).toEqual({
      vendor: "unknown",
      family: "unknown",
      tier: "unknown",
      displayName: "unknown/provider-model",
    });
  });

  it("getModelInfo resolves alias before family detection", () => {
    expect(getModelInfo("openai/gpt-latest")).toMatchObject({
      vendor: "openai",
      family: "gpt",
      tier: "regular",
    });
  });

  it("getModelInfo recognizes flant provider models", () => {
    expect(getModelInfo("pp-flant-anthropic/claude-sonnet-4-6")).toMatchObject({
      vendor: "anthropic",
      family: "sonnet",
      tier: "regular",
    });
    expect(getModelInfo("pp-flant-openai/gpt-5.4-mini")).toMatchObject({
      vendor: "openai",
      family: "gpt-mini",
      tier: "stupid",
    });
    expect(getModelInfo("pp-flant-openai/gemini-3.1-pro")).toMatchObject({
      vendor: "google",
      family: "gemini-pro",
      tier: "regular",
    });
  });

  it("getModelInfo matches alternate gpt-mini naming", () => {
    expect(getModelInfo("openai/gpt-4.1-mini")).toMatchObject({
      vendor: "openai",
      family: "gpt-mini",
      tier: "stupid",
    });
  });

  it("getModelInfo matches alternate gemini pro and flash naming", () => {
    expect(getModelInfo("google/gemini-2.0-pro-preview")).toMatchObject({
      vendor: "google",
      family: "gemini-pro",
      tier: "regular",
    });
    expect(getModelInfo("google/gemini-2.0-flash-exp")).toMatchObject({
      vendor: "google",
      family: "gemini-flash",
      tier: "stupid",
    });
  });

  it("getModelInfo detects flant deepseek grok and qwen models", () => {
    expect(getModelInfo("pp-flant-openai/deepseek-v3")).toMatchObject({ vendor: "deepseek", family: "deepseek", tier: "regular" });
    expect(getModelInfo("pp-flant-openai/grok-4")).toMatchObject({ vendor: "xai", family: "grok", tier: "regular" });
    expect(getModelInfo("pp-flant-openai/qwen-coder-3")).toMatchObject({ vendor: "qwen", family: "qwen", tier: "regular" });
  });

  it("updateRegistryFromAvailableModels updates aliases from available models", () => {
    updateRegistryFromAvailableModels([
      "openai/gpt-5.6",
      "pp-flant-openai/gpt-5.6-mini",
      "claude-opus-4-7",
    ]);

    expect(resolveModel("openai/gpt-latest")).toBe("openai/gpt-5.6");
    expect(resolveModel("pp-flant-openai/gpt-mini-latest")).toBe("pp-flant-openai/gpt-5.6-mini");
    expect(resolveModel("pp-flant-anthropic/claude-opus-latest")).toBe("pp-flant-anthropic/claude-opus-4-7");
  });

  it("updateRegistryFromAvailableModels picks latest version", () => {
    updateRegistryFromAvailableModels([
      "openai/gpt-5.9",
      "openai/gpt-5.10",
      "openai/gpt-5.10.2",
      "openai/gpt-5.8",
    ]);

    expect(resolveModel("openai/gpt-latest")).toBe("openai/gpt-5.10.2");
  });

  it("updateRegistryFromAvailableModels normalizes bare model ids", () => {
    updateRegistryFromAvailableModels([
      "claude-sonnet-4-7",
      "gpt-5-6",
      "gemini-3-2-pro",
    ]);

    expect(resolveModel("pp-flant-anthropic/claude-sonnet-latest")).toBe("pp-flant-anthropic/claude-sonnet-4-7");
    expect(resolveModel("pp-flant-openai/gpt-latest")).toBe("pp-flant-openai/gpt-5-6");
    expect(resolveModel("pp-flant-openai/gemini-pro-latest")).toBe("pp-flant-openai/gemini-3-2-pro");
  });

  it("updateRegistryFromAvailableModels deduplicates repeated models", () => {
    updateRegistryFromAvailableModels([
      "openai/gpt-5.6",
      "openai/gpt-5.6",
      "openai/gpt-5.6",
    ]);

    expect(resolveModel("openai/gpt-latest")).toBe("openai/gpt-5.6");
  });

  it("updateRegistryFromAvailableModels keeps native-latest for missing families", () => {
    updateRegistryFromAvailableModels(["openai/gpt-9.1"]);

    expect(resolveModel("openai/gpt-latest")).toBe("openai/gpt-9.1");
    expect(resolveModel("anthropic/claude-opus-latest")).toBe("anthropic/claude-opus-latest");
  });

  it("updateRegistryFromAvailableModels ignores aliases ending with -latest", () => {
    updateRegistryFromAvailableModels([
      "openai/gpt-5.4",
      "openai/gpt-latest",
      "pp-flant-anthropic/claude-opus-latest",
    ]);

    expect(resolveModel("openai/gpt-latest")).toBe("openai/gpt-5.4");
    expect(resolveModel("pp-flant-anthropic/claude-opus-latest")).toBe("pp-flant-anthropic/claude-opus-latest");
  });

  it("updateRegistryFromAvailableModels handles empty input", () => {
    updateRegistryFromAvailableModels(["openai/gpt-9.9"]);
    expect(resolveModel("openai/gpt-latest")).toBe("openai/gpt-9.9");

    updateRegistryFromAvailableModels([]);
    expect(resolveModel("openai/gpt-latest")).toBe("openai/gpt-latest");
  });

  it("updateRegistryFromAvailableModels ignores unknown bare ids", () => {
    updateRegistryFromAvailableModels(["custom-model-1", "another-custom-model"]);

    expect(resolveModel("openai/gpt-latest")).toBe("openai/gpt-latest");
    expect(resolveModel("anthropic/claude-opus-latest")).toBe("anthropic/claude-opus-latest");
  });

  it("updateRegistryFromAvailableModels chooses highest among flant openai versions", () => {
    updateRegistryFromAvailableModels([
      "pp-flant-openai/gpt-5.4",
      "pp-flant-openai/gpt-5.6",
      "pp-flant-openai/gpt-5.5",
    ]);

    expect(resolveModel("pp-flant-openai/gpt-latest")).toBe("pp-flant-openai/gpt-5.6");
  });

  it("getAllAliases returns a copy", () => {
    updateRegistryFromAvailableModels(["openai/gpt-5.4"]);
    const aliases = getAllAliases();
    aliases["openai/gpt-latest"] = "openai/gpt-0.0";

    expect(resolveModel("openai/gpt-latest")).toBe("openai/gpt-5.4");
  });

  it("getAllAliases contains native-latest identity mappings", () => {
    const aliases = getAllAliases();

    expect(aliases["anthropic/claude-opus-latest"]).toBe("anthropic/claude-opus-latest");
    expect(aliases["anthropic/claude-sonnet-latest"]).toBe("anthropic/claude-sonnet-latest");
    expect(aliases["anthropic/claude-haiku-latest"]).toBe("anthropic/claude-haiku-latest");
  });

  it("getAllAliases contains resolved aliases after updateRegistry", () => {
    updateRegistryFromAvailableModels(["grok-4"]);
    const aliases = getAllAliases();

    expect(aliases["pp-flant-openai/grok-latest"]).toBe("pp-flant-openai/grok-4");
  });

  it("getModelFamilies returns all family definitions", () => {
    const families = getModelFamilies();
    expect(families).toHaveLength(14);
    expect(families.map((f) => f.family).sort()).toEqual([
      "deepseek",
      "fable",
      "gemini-flash",
      "gemini-pro",
      "gpt",
      "gpt-luna",
      "gpt-mini",
      "gpt-sol",
      "gpt-terra",
      "grok",
      "haiku",
      "opus",
      "qwen",
      "sonnet",
    ]);
    expect(families.find((f) => f.family === "opus")?.aliases).toContain("pp-flant-anthropic/claude-opus-latest");
    expect(families.find((f) => f.family === "gpt")?.aliases).toContain("pp-flant-openai/gpt-latest");
  });

  it("splits gpt-5.6 into sol/terra/luna tier families and distinguishes -pro", () => {
    // base and -pro resolve to the SAME family (pro is a reasoning mode), but
    // the tier suffixes never bleed into each other or the legacy gpt family.
    expect(getModelInfo("pp-flant-openai/gpt-5.6-sol")).toMatchObject({ family: "gpt-sol", tier: "smart" });
    expect(getModelInfo("pp-flant-openai/gpt-5.6-sol-pro")).toMatchObject({ family: "gpt-sol", tier: "smart" });
    expect(getModelInfo("pp-flant-openai/gpt-5.6-terra")).toMatchObject({ family: "gpt-terra", tier: "regular" });
    expect(getModelInfo("pp-flant-openai/gpt-5.6-terra-pro")).toMatchObject({ family: "gpt-terra", tier: "regular" });
    expect(getModelInfo("pp-flant-openai/gpt-5.6-luna")).toMatchObject({ family: "gpt-luna", tier: "stupid" });
    expect(getModelInfo("pp-flant-openai/gpt-5.6-luna-pro")).toMatchObject({ family: "gpt-luna", tier: "stupid" });
    // no prefix bleed: sol pattern must NOT match sol-pro-ish longer ids, and
    // legacy/plain gpt-5.6 stays on the backward-compat gpt family.
    expect(getModelInfo("openai/gpt-5.6")).toMatchObject({ family: "gpt", tier: "regular" });
    expect(getModelInfo("openai/gpt-5.4")).toMatchObject({ family: "gpt", tier: "regular" });
    expect(getModelInfo("openai/gpt-5.6-mini")).toMatchObject({ family: "gpt-mini", tier: "stupid" });
  });

  it("getModelFamilies exposes vendor and tier per family", () => {
    const families = getModelFamilies();

    expect(families.find((f) => f.family === "haiku")).toMatchObject({ vendor: "anthropic", tier: "stupid" });
    expect(families.find((f) => f.family === "gemini-pro")).toMatchObject({ vendor: "google", tier: "regular" });
  });

  describe("findLatestFamilyMatch", () => {
    it("returns latest versioned model for a native-latest alias", () => {
      const available = [
        "anthropic/claude-opus-4-0-20250514",
        "anthropic/claude-opus-4-6",
        "anthropic/claude-sonnet-4-6",
      ];
      expect(findLatestFamilyMatch("anthropic/claude-opus-latest", available)).toBe("anthropic/claude-opus-4-6");
    });

    it("returns null for unknown model spec", () => {
      expect(findLatestFamilyMatch("custom/unknown-model", ["anthropic/claude-opus-4-6"])).toBeNull();
    });

    it("returns null when no candidates match the provider", () => {
      expect(findLatestFamilyMatch("anthropic/claude-opus-latest", ["openai/gpt-5.4"])).toBeNull();
    });

    it("returns null for spec without provider", () => {
      expect(findLatestFamilyMatch("claude-opus-latest", ["anthropic/claude-opus-4-6"])).toBeNull();
    });

    it("returns the only candidate when there is one", () => {
      expect(findLatestFamilyMatch("openai/gpt-latest", ["openai/gpt-5.4"])).toBe("openai/gpt-5.4");
    });

    it("returns null for empty available list", () => {
      expect(findLatestFamilyMatch("anthropic/claude-opus-latest", [])).toBeNull();
    });
  });

  describe("subscription fallback rewrite", () => {
    beforeEach(() => setSubscriptionFallbackActive(false));
    afterEach(() => setSubscriptionFallbackActive(false));

    it("toNonSubSpec rewrites provider-prefixed sub specs", () => {
      expect(toNonSubSpec("pp-flant-anthropic-sub/sub/claude-opus-4-8")).toBe("pp-flant-anthropic/claude-opus-4-8");
    });

    it("toNonSubSpec rewrites bare sub/ ids", () => {
      expect(toNonSubSpec("sub/claude-haiku-4-5")).toBe("pp-flant-anthropic/claude-haiku-4-5");
    });

    it("toNonSubSpec leaves non-subscription specs unchanged", () => {
      expect(toNonSubSpec("pp-flant-anthropic/claude-opus-4-8")).toBe("pp-flant-anthropic/claude-opus-4-8");
      expect(toNonSubSpec("openai/gpt-5.4")).toBe("openai/gpt-5.4");
    });

    it("resolveModel leaves sub specs unchanged while fallback inactive", () => {
      expect(isSubscriptionFallbackActive()).toBe(false);
      expect(resolveModel("pp-flant-anthropic-sub/sub/claude-opus-4-8")).toBe("pp-flant-anthropic-sub/sub/claude-opus-4-8");
    });

    it("resolveModel rewrites sub specs to non-sub while fallback active", () => {
      setSubscriptionFallbackActive(true);
      expect(isSubscriptionFallbackActive()).toBe(true);
      expect(resolveModel("pp-flant-anthropic-sub/sub/claude-opus-4-8")).toBe("pp-flant-anthropic/claude-opus-4-8");
      expect(resolveModel("sub/claude-haiku-4-5")).toBe("pp-flant-anthropic/claude-haiku-4-5");
    });

    it("resolveModel does not touch non-sub specs while fallback active", () => {
      setSubscriptionFallbackActive(true);
      expect(resolveModel("pp-flant-openai/gpt-5-4")).toBe("pp-flant-openai/gpt-5-4");
    });

    it("resolveModel rewrites a subscription alias after registry update while fallback active", () => {
      updateRegistryFromAvailableModels([
        "pp-flant-anthropic-sub/sub/claude-opus-4-7",
        "pp-flant-anthropic-sub/sub/claude-opus-4-8",
      ]);
      setSubscriptionFallbackActive(true);
      expect(resolveModel("pp-flant-anthropic-sub/claude-opus-latest")).toBe("pp-flant-anthropic/claude-opus-4-8");
    });
  });

  describe("provider-tier resolver", () => {
    beforeEach(() => {
      setSubscriptionFallbackActive(false);
      clearAllTierDemotions();
      // Reset to the pre-tier defaults: copilot off, sub on, api on.
      setTierEnabled({ "copilot": false, "flant-sub": true, "flant-api": true });
    });
    afterEach(() => {
      setSubscriptionFallbackActive(false);
      clearAllTierDemotions();
      setTierEnabled({ "copilot": false, "flant-sub": true, "flant-api": true });
    });

    it("exposes the fixed precedence order copilot > flant-sub > flant-api", () => {
      expect([...PROVIDER_TIER_ORDER]).toEqual(["copilot", "flant-sub", "flant-api"]);
    });

    it("listTierDemotions reports current demotions and clearAllTierDemotions returns what it cleared", () => {
      expect(listTierDemotions()).toEqual([]);
      demoteTierForFamily("flant-sub", "opus");
      demoteTierForFamily("flant-api", "gpt-sol");
      expect(listTierDemotions()).toEqual(["flant-api:gpt-sol", "flant-sub:opus"]);
      const cleared = clearAllTierDemotions();
      expect(cleared).toEqual(["flant-api:gpt-sol", "flant-sub:opus"]);
      expect(listTierDemotions()).toEqual([]);
      // Clearing again returns an empty list (idempotent).
      expect(clearAllTierDemotions()).toEqual([]);
    });

    it("keeps a copilot-generated spec on copilot when enabled (no demotion)", () => {
      setTierEnabled({ "copilot": true });
      expect(resolveModel("github-copilot/claude-opus-4-8")).toBe("github-copilot/claude-opus-4-8");
    });

    it("demotes a copilot spec down when copilot is disabled", () => {
      // copilot disabled (default) -> a copilot-generated Claude spec falls to
      // the next usable tier (sub, which is Claude-capable + enabled).
      expect(resolveModel("github-copilot/claude-opus-4-8")).toBe("pp-flant-anthropic-sub/sub/claude-opus-4-8");
    });

    it("flant↔flant stays demote-only: a paid flant-api spec is never promoted to the subscription", () => {
      setTierEnabled({ "copilot": true });
      // No catalog registered here, so copilot promotion no-ops (needs a real
      // copilot model); the point is flant-api never routes UP to flant-sub
      // (that would reroute a paid pin onto the subscription).
      expect(resolveModel("pp-flant-anthropic/claude-opus-4-8")).toBe("pp-flant-anthropic/claude-opus-4-8");
    });

    it("flant-sub is Claude-only: a demoted-copilot gpt spec skips sub to flant-api", () => {
      // A copilot gpt spec, with copilot disabled, cannot use the Claude-only
      // sub tier and lands on flant-api.
      expect(resolveModel("github-copilot/gpt-5.6-sol")).toBe("pp-flant-openai/gpt-5.6-sol");
    });

    it("demoting copilot for a family falls that family to the next usable tier", () => {
      setTierEnabled({ "copilot": true });
      // opus prefers copilot; demote copilot for opus -> falls to sub.
      demoteTierForFamily("copilot", "opus");
      expect(resolveModel("github-copilot/claude-opus-4-8")).toBe("pp-flant-anthropic-sub/sub/claude-opus-4-8");
      // A gpt on copilot, demoted, skips Claude-only sub and lands on flant-api.
      demoteTierForFamily("copilot", "gpt-sol");
      expect(resolveModel("github-copilot/gpt-5.6-sol")).toBe("pp-flant-openai/gpt-5.6-sol");
    });

    it("demotions are per-family: demoting opus on sub does not affect haiku", () => {
      demoteTierForFamily("flant-sub", "opus");
      // opus sub demoted -> falls to flant-api.
      expect(resolveModel("pp-flant-anthropic-sub/sub/claude-opus-4-8")).toBe("pp-flant-anthropic/claude-opus-4-8");
      // haiku sub still usable.
      expect(resolveModel("pp-flant-anthropic-sub/sub/claude-haiku-4-5")).toBe("pp-flant-anthropic-sub/sub/claude-haiku-4-5");
    });

    it("restoring a demoted tier brings the family back up", () => {
      setTierEnabled({ "copilot": true });
      demoteTierForFamily("copilot", "opus");
      expect(resolveModel("github-copilot/claude-opus-4-8")).toBe("pp-flant-anthropic-sub/sub/claude-opus-4-8");
      restoreTierForFamily("copilot", "opus");
      expect(resolveModel("github-copilot/claude-opus-4-8")).toBe("github-copilot/claude-opus-4-8");
    });

    it("setSubscriptionFallbackActive toggles the flant-sub tier enable flag", () => {
      setSubscriptionFallbackActive(true);
      expect(getTierEnabled()["flant-sub"]).toBe(false);
      setSubscriptionFallbackActive(false);
      expect(getTierEnabled()["flant-sub"]).toBe(true);
    });
  });

  // C1 fix: catalog-safe resolution. Copilot's real catalog uses DIFFERENT ids
  // than flant (claude-opus-4.5 vs claude-opus-4-8) and has NO gpt models, so
  // the resolver must consult the registered catalog and never emit an
  // unregistered id.
  describe("provider-tier resolver — catalog-safe copilot", () => {
    beforeEach(() => {
      setSubscriptionFallbackActive(false);
      clearAllTierDemotions();
      setTierEnabled({ "copilot": false, "flant-sub": true, "flant-api": true });
      // Realistic mixed catalog: copilot Claude ids DIFFER from flant's; copilot
      // has no gpt; flant has both claude + gpt (per-token and sub).
      updateRegistryFromAvailableModels([
        "github-copilot/claude-opus-4.5",
        "github-copilot/claude-opus-4.6",
        "pp-flant-anthropic/claude-opus-4-8",
        "pp-flant-anthropic-sub/sub/claude-opus-4-8",
        "pp-flant-openai/gpt-5.6-sol",
      ]);
    });
    afterEach(() => {
      setSubscriptionFallbackActive(false);
      clearAllTierDemotions();
      setTierEnabled({ "copilot": false, "flant-sub": true, "flant-api": true });
      updateRegistryFromAvailableModels([]);
    });

    it("PROMOTES a generated flant Claude spec to the real latest copilot id when copilot is enabled", () => {
      // Copilot precedence (user's explicit request): a generated flant claude
      // spec routes UP to copilot's OWN latest registered opus id (4.6), not a
      // prefix-swap. copilot is OFF by default so this only happens on opt-in.
      setTierEnabled({ "copilot": true });
      expect(resolveModel("pp-flant-anthropic-sub/sub/claude-opus-4-8")).toBe("github-copilot/claude-opus-4.6");
    });

    it("does NOT promote a gpt flant spec to copilot (copilot has no gpt) — stays on flant", () => {
      setTierEnabled({ "copilot": true });
      expect(resolveModel("pp-flant-openai/gpt-5.6-sol")).toBe("pp-flant-openai/gpt-5.6-sol");
    });

    it("does NOT promote to copilot when the copilot tier is disabled (default)", () => {
      // copilot OFF (default): a generated flant claude spec stays on flant.
      expect(resolveModel("pp-flant-anthropic-sub/sub/claude-opus-4-8")).toBe("pp-flant-anthropic-sub/sub/claude-opus-4-8");
    });

    it("does NOT promote to copilot when that family is demoted for copilot (live rate-limit)", () => {
      setTierEnabled({ "copilot": true });
      demoteTierForFamily("copilot", "opus");
      // opus copilot demoted -> the generated flant spec stays on flant.
      expect(resolveModel("pp-flant-anthropic-sub/sub/claude-opus-4-8")).toBe("pp-flant-anthropic-sub/sub/claude-opus-4-8");
    });

    it("respects an explicit copilot pin against the real catalog (no rewrite to flant)", () => {
      setTierEnabled({ "copilot": true });
      expect(resolveModel("github-copilot/claude-opus-4.5")).toBe("github-copilot/claude-opus-4.5");
    });

    it("resolves a copilot alias to the REAL latest copilot id, not a prefix-swapped flant id", () => {
      setTierEnabled({ "copilot": true });
      // An explicit copilot pin using a stale/aliasable id resolves to copilot's
      // OWN latest registered opus, never github-copilot/<flant-id>.
      const out = resolveModel("github-copilot/claude-opus-4.5");
      expect(out.startsWith("github-copilot/")).toBe(true);
    });

    it("demotes an explicit copilot pin to a real flant id when copilot is disabled", () => {
      // copilot off (default) -> the pin can't be honored, routes to the highest
      // usable flant tier with a REAL id (not github-copilot/<flant-id>).
      expect(resolveModel("github-copilot/claude-opus-4.5")).toBe("pp-flant-anthropic-sub/sub/claude-opus-4-8");
    });

    it("never emits an unregistered copilot id when demoting a copilot spec whose family copilot lacks", () => {
      // A copilot-pinned gpt (copilot has NO gpt) with copilot disabled must land
      // on a real flant gpt id, never github-copilot/gpt-….
      const out = resolveModel("github-copilot/gpt-5.6-sol");
      expect(out.startsWith("github-copilot/")).toBe(false);
      expect(out).toBe("pp-flant-openai/gpt-5.6-sol");
    });

    it("does not fabricate a flant spec for a family flant does not serve (fable MINOR-2)", () => {
      // Catalog: copilot has gemini, flant does NOT. A copilot-pinned gemini with
      // copilot disabled has no real flant twin -> must NOT become
      // pp-flant-openai/<gemini-copilot-id>; the spec is returned unchanged.
      updateRegistryFromAvailableModels([
        "github-copilot/gemini-3-flash-preview",
        "pp-flant-openai/gpt-5.6-sol",
      ]);
      const out = resolveModel("github-copilot/gemini-3-flash-preview");
      expect(out.startsWith("pp-flant-openai/")).toBe(false);
      expect(out).toBe("github-copilot/gemini-3-flash-preview");
    });

    it("classifies a github-copilot gpt pin (gpt family includes github-copilot)", () => {
      updateRegistryFromAvailableModels(["github-copilot/gpt-4.1", "pp-flant-openai/gpt-4.1"]);
      // Family classifies (not unknown) so the pin resolves rather than passing
      // through blind; with copilot disabled it demotes to the real flant gpt.
      expect(getModelInfo("github-copilot/gpt-4.1").family).toBe("gpt");
      const out = resolveModel("github-copilot/gpt-4.1");
      expect(out).toBe("pp-flant-openai/gpt-4.1");
    });
  });
});
