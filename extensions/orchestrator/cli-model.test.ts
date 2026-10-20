import { describe, expect, it, vi } from "vitest";
import { cliModelRequest, resolveCliRequest } from "./cli-model.js";
import { Orchestrator } from "./orchestrator.js";
import { getDefaultConfig, normalizeConfigDurations } from "./config.js";

const models = [
  { provider: "anthropic", id: "claude-sonnet-4-5" },
  { provider: "pp-flant-anthropic-sub", id: "sub/claude-opus-4-5" },
  { provider: "github-copilot", id: "claude-opus-4.5" },
];
const registry = { getAll: () => models, hasConfiguredAuth: (model: any) => model.provider !== "anthropic" };

describe("cliModelRequest", () => {
  it("reads --model, --provider and --thinking the way pi parses them", () => {
    expect(cliModelRequest(["--mode", "rpc", "--model", "sub/claude-opus-4-5", "--thinking", "high"])).toEqual({ model: "sub/claude-opus-4-5", provider: undefined, thinking: "high" });
    expect(cliModelRequest(["--provider", "github-copilot", "--model", "claude-opus-4.5"])).toEqual({ model: "claude-opus-4.5", provider: "github-copilot", thinking: undefined });
    expect(cliModelRequest(["--mode", "rpc", "--no-session"])).toBeNull();
  });
});

describe("resolveCliRequest", () => {
  it("finds a model only pi-pi's providers register, by its full or partial name", () => {
    expect(resolveCliRequest({ model: "pp-flant-anthropic-sub/sub/claude-opus-4-5" }, registry)!.model).toBe(models[1]);
    expect(resolveCliRequest({ model: "sub/claude-opus-4-5" }, registry)!.model).toBe(models[1]);
    expect(resolveCliRequest({ model: "claude-opus-4.5", provider: "github-copilot" }, registry)!.model).toBe(models[2]);
  });

  it("takes a thinking level from model:thinking unless --thinking says otherwise", () => {
    expect(resolveCliRequest({ model: "anthropic/claude-sonnet-4-5:low" }, registry)).toEqual({ model: models[0], thinking: "low" });
    expect(resolveCliRequest({ model: "anthropic/claude-sonnet-4-5:low", thinking: "high" }, registry)!.thinking).toBe("high");
  });

  it("returns nothing for a model nobody provides", () => {
    expect(resolveCliRequest({ model: "nope/nothing" }, registry)).toBeNull();
  });
});

describe("Orchestrator.applyCliModel", () => {
  function setup() {
    const pi: any = { setModel: vi.fn(async () => true), setThinkingLevel: vi.fn() };
    const orchestrator = new Orchestrator(pi);
    orchestrator.config = normalizeConfigDurations(getDefaultConfig());
    return { pi, orchestrator };
  }

  it("puts the session on the requested model as the user's own pick", async () => {
    const { pi, orchestrator } = setup();
    orchestrator.routedMainSpec = "github-copilot/claude-opus-4.5";
    const ctx: any = { modelRegistry: registry, model: models[2] };
    expect(await orchestrator.applyCliModel(ctx, { model: "sub/claude-opus-4-5", thinking: "high" })).toBe("applied");
    expect(pi.setModel).toHaveBeenCalledWith(models[1]);
    expect(pi.setThinkingLevel).toHaveBeenCalledWith("high");
    expect(orchestrator.routedMainSpec).toBeNull();
  });

  it("does nothing without a request, and reports a request that matches nothing", async () => {
    const { pi, orchestrator } = setup();
    const ctx: any = { modelRegistry: registry };
    expect(await orchestrator.applyCliModel(ctx, null)).toBe("none");
    expect(await orchestrator.applyCliModel(ctx, { model: "nope/nothing" })).toBe("unknown");
    expect(pi.setModel).not.toHaveBeenCalled();
  });
});
