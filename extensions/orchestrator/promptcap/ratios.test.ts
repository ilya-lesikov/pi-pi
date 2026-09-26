import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileRatioStore } from "./ratios.js";
import { PromptGuard } from "./guard.js";
import { Estimator } from "./estimate.js";
import type { PromptcapSettings } from "./limits.js";
import type { AgentMessage } from "./fold.js";

let dir = "";
let previous: string | undefined;

const file = () => join(dir, "extensions", "pp", "promptcap-ratios.json");

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pp-ratios-"));
  previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
});

afterEach(() => {
  if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previous;
  rmSync(dir, { recursive: true, force: true });
});

const settings = (): PromptcapSettings => ({ enabled: true, perModel: {} });

const ctx = () => ({
  model: { provider: "anthropic", id: "claude-opus-4-8" },
  getSystemPrompt: () => "system",
  getContextUsage: () => ({ tokens: null, contextWindow: 1_000_000, percent: null }),
});

const conversation = (): AgentMessage[] => [
  { role: "user", content: [{ type: "text", text: "go" }] },
  { role: "assistant", content: [{ type: "toolCall", id: "t0", name: "read", arguments: { path: "/f" } }] },
  { role: "toolResult", toolCallId: "t0", toolName: "read", content: [{ type: "text", text: "o".repeat(4_000) }], isError: false },
];

describe("fileRatioStore", () => {
  it("reads back what it wrote", () => {
    const store = fileRatioStore();
    store.save({ "anthropic/claude-opus-4-8": 1.3 });
    expect(fileRatioStore().load()).toEqual({ "anthropic/claude-opus-4-8": 1.3 });
  });

  it("keeps what another session learned about a model it never used", () => {
    mkdirSync(join(dir, "extensions", "pp"), { recursive: true });
    writeFileSync(file(), JSON.stringify({ "openai/gpt": 0.9 }), "utf-8");

    fileRatioStore().save({ "anthropic/claude-opus-4-8": 1.3 });

    expect(JSON.parse(readFileSync(file(), "utf-8"))).toEqual({ "openai/gpt": 0.9, "anthropic/claude-opus-4-8": 1.3 });
  });

  it("writes no more than once in an interval, however many turns report", () => {
    const store = fileRatioStore();
    store.save({ m: 1.3 });
    store.save({ m: 1.9 });
    expect(fileRatioStore().load()).toEqual({ m: 1.3 });
  });

  it("survives a file that is missing, empty or nonsense", () => {
    expect(fileRatioStore().load()).toEqual({});
    mkdirSync(join(dir, "extensions", "pp"), { recursive: true });
    writeFileSync(file(), "{ not json", "utf-8");
    expect(fileRatioStore().load()).toEqual({});
    writeFileSync(file(), JSON.stringify({ m: "big", n: -1, o: 1.2 }), "utf-8");
    expect(fileRatioStore().load()).toEqual({ o: 1.2 });
  });
});

describe("a guard that outlives its process", () => {
  it("sizes its first prompt against what the model charged last time", () => {
    const cold = new PromptGuard({ settings });
    const warm = new PromptGuard({ settings, ratios: { load: () => ({ "anthropic/claude-opus-4-8": 2 }), save: () => {} } });

    cold.apply(conversation(), ctx(), []);
    warm.apply(conversation(), ctx(), []);

    expect(warm.lastTokens).toBe(cold.lastTokens! * 2);
  });

  it("carries what it learned through a conversation being replaced", () => {
    const saved: Record<string, number>[] = [];
    const guard = new PromptGuard({ settings, ratios: { load: () => ({}), save: (r) => { saved.push(r); } } });

    guard.apply(conversation(), ctx(), []);
    guard.calibrate(20_000, "anthropic/claude-opus-4-8");
    const learned = guard.ratioFor("anthropic/claude-opus-4-8");
    guard.reset();

    expect(learned).toBeGreaterThan(0);
    expect(guard.ratioFor("anthropic/claude-opus-4-8")).toBe(learned);
    expect(saved).toEqual([{ "anthropic/claude-opus-4-8": learned }]);
  });

  it("prefers a reading from this conversation over one carried in", () => {
    const estimator = new Estimator();
    estimator.observe("m", 1_000, 1_500);
    estimator.restore({ m: 9, other: 4 });

    expect(estimator.ratioFor("m")).toBe(1.5);
    expect(estimator.ratioFor("other")).toBe(4);
  });
});
