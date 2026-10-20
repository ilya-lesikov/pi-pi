import { describe, expect, it } from "vitest";
import { cliModelRequest } from "./cli-model.js";
import { Orchestrator } from "./orchestrator.js";
import { getDefaultConfig, normalizeConfigDurations } from "./config.js";

describe("cliModelRequest", () => {
  it("reads --model, --provider and --thinking the way pi parses them", () => {
    expect(cliModelRequest(["--mode", "rpc", "--model", "sub/claude-opus-4-5", "--thinking", "high"])).toEqual({ model: "sub/claude-opus-4-5", provider: undefined, thinking: "high" });
    expect(cliModelRequest(["--provider", "github-copilot", "--model", "claude-opus-4.5"])).toEqual({ model: "claude-opus-4.5", provider: "github-copilot", thinking: undefined });
    expect(cliModelRequest(["--mode", "rpc", "--no-session"])).toBeNull();
  });
});

describe("Orchestrator.keepCliModel", () => {
  it("marks the session's model as picked by hand, so routing never moves it", () => {
    const orchestrator = new Orchestrator({} as any);
    orchestrator.config = normalizeConfigDurations(getDefaultConfig());
    orchestrator.routedMainSpec = "github-copilot/claude-opus-4.5";
    expect(orchestrator.keepCliModel({ model: "sub/claude-opus-4-5" })).toBe(true);
    expect(orchestrator.routedMainSpec).toBeNull();
    expect(orchestrator.mainPickedByHand).toBe(true);
  });

  it("does nothing without a request", () => {
    const orchestrator = new Orchestrator({} as any);
    expect(orchestrator.keepCliModel(null)).toBe(false);
    expect(orchestrator.mainPickedByHand).toBe(false);
  });
});
