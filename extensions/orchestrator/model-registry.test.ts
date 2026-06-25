import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./log.js", () => ({
  getLogger: () => ({
    debug: vi.fn(),
  }),
}));

import {
  getAllAliases,
  getModelFamilies,
  getModelInfo,
  resolveModel,
  updateRegistryFromAvailableModels,
} from "./model-registry.js";

describe("model-registry", () => {
  beforeEach(() => {
    updateRegistryFromAvailableModels([]);
  });

  it("resolveModel resolves known aliases", () => {
    expect(resolveModel("anthropic/claude-sonnet-latest")).toBe("anthropic/claude-sonnet-4-6");
    expect(resolveModel("openai/gpt-mini-latest")).toBe("openai/gpt-5.4-mini");
  });

  it("resolveModel passes through unknown aliases", () => {
    expect(resolveModel("custom/provider-model")).toBe("custom/provider-model");
  });

  it("resolveModel resolves flant aliases", () => {
    expect(resolveModel("pp-flant-anthropic/claude-opus-latest")).toBe("pp-flant-anthropic/claude-opus-4-6");
    expect(resolveModel("pp-flant-openai/gemini-pro-latest")).toBe("pp-flant-openai/gemini-3.1-pro");
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

  it("updateRegistryFromAvailableModels keeps defaults for missing families", () => {
    updateRegistryFromAvailableModels(["openai/gpt-9.1"]);

    expect(resolveModel("openai/gpt-latest")).toBe("openai/gpt-9.1");
    expect(resolveModel("anthropic/claude-opus-latest")).toBe("anthropic/claude-opus-4-6");
  });

  it("updateRegistryFromAvailableModels ignores aliases ending with -latest", () => {
    updateRegistryFromAvailableModels([
      "openai/gpt-5.4",
      "openai/gpt-latest",
      "pp-flant-anthropic/claude-opus-latest",
    ]);

    expect(resolveModel("openai/gpt-latest")).toBe("openai/gpt-5.4");
    expect(resolveModel("pp-flant-anthropic/claude-opus-latest")).toBe("pp-flant-anthropic/claude-opus-4-6");
  });

  it("updateRegistryFromAvailableModels handles empty input", () => {
    updateRegistryFromAvailableModels(["openai/gpt-9.9"]);
    expect(resolveModel("openai/gpt-latest")).toBe("openai/gpt-9.9");

    updateRegistryFromAvailableModels([]);
    expect(resolveModel("openai/gpt-latest")).toBe("openai/gpt-5.4");
  });

  it("updateRegistryFromAvailableModels ignores unknown bare ids", () => {
    updateRegistryFromAvailableModels(["custom-model-1", "another-custom-model"]);

    expect(resolveModel("openai/gpt-latest")).toBe("openai/gpt-5.4");
    expect(resolveModel("anthropic/claude-opus-latest")).toBe("anthropic/claude-opus-4-6");
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
    const aliases = getAllAliases();
    aliases["openai/gpt-latest"] = "openai/gpt-0.0";

    expect(resolveModel("openai/gpt-latest")).toBe("openai/gpt-5.4");
  });

  it("getAllAliases contains known defaults", () => {
    const aliases = getAllAliases();

    expect(aliases["anthropic/claude-opus-latest"]).toBe("anthropic/claude-opus-4-6");
    expect(aliases["pp-flant-openai/grok-latest"]).toBe("pp-flant-openai/grok-4");
  });

  it("getModelFamilies returns all family definitions", () => {
    const families = getModelFamilies();
    expect(families).toHaveLength(10);
    expect(families.map((f) => f.family).sort()).toEqual([
      "deepseek",
      "gemini-flash",
      "gemini-pro",
      "gpt",
      "gpt-mini",
      "grok",
      "haiku",
      "opus",
      "qwen",
      "sonnet",
    ]);
    expect(families.find((f) => f.family === "opus")?.aliases).toContain("pp-flant-anthropic/claude-opus-latest");
    expect(families.find((f) => f.family === "gpt")?.aliases).toContain("pp-flant-openai/gpt-latest");
  });

  it("getModelFamilies exposes vendor and tier per family", () => {
    const families = getModelFamilies();

    expect(families.find((f) => f.family === "haiku")).toMatchObject({ vendor: "anthropic", tier: "stupid" });
    expect(families.find((f) => f.family === "gemini-pro")).toMatchObject({ vendor: "google", tier: "regular" });
  });
});
