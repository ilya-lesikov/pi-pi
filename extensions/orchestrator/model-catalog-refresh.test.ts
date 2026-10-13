import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@earendil-works/pi-ai/oauth", () => ({}));

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-pi-catalog-"));
  tempDirs.push(dir);
  return dir;
}

function makePi(): any {
  const handlers = new Map<string, Array<(...args: any[]) => any>>();
  return {
    handlers,
    events: { emit: vi.fn(), on: vi.fn(() => () => {}) },
    on: vi.fn((name: string, handler: (...args: any[]) => any) => {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    }),
    getAllTools: vi.fn(() => []),
    registerTool: vi.fn(),
    registerCommand: vi.fn(),
    registerProvider: vi.fn(),
    unregisterProvider: vi.fn(),
    sendUserMessage: vi.fn(),
    sendMessage: vi.fn(),
    appendEntry: vi.fn(),
  };
}

async function emit(pi: any, name: string, event: any, ctx: any): Promise<void> {
  for (const handler of pi.handlers.get(name) ?? []) await handler(event, ctx);
}

function writeAuth(agentDir: string, entries: Record<string, unknown>): void {
  writeFileSync(join(agentDir, "auth.json"), JSON.stringify(entries), "utf-8");
}

function writeGlobalProvidersConfig(agentDir: string, providers: Record<string, unknown>): void {
  const dir = join(agentDir, "extensions", "pp");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.json"), JSON.stringify({ providers }), "utf-8");
}

afterEach(() => {
  vi.useRealTimers();
  delete process.env.PI_CODING_AGENT_DIR;
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("mid-session model catalog refresh", () => {
  // A /login lands between turns: the session-start snapshot predates the
  // provider's models, so without a refresh the provider is enabled,
  // credentialed and permanently skipped for having an empty catalog.
  it("picks up a provider's models when its credential appears after session start", async () => {
    const agentDir = makeTempDir();
    process.env.PI_CODING_AGENT_DIR = agentDir;
    writeAuth(agentDir, {});
    writeGlobalProvidersConfig(agentDir, { codex: { enabled: true }, copilot: { enabled: false }, "claude-sub": { enabled: false } });
    vi.resetModules();

    const { registerEventHandlers } = await import("./event-handlers.js");
    const { Orchestrator } = await import("./orchestrator.js");
    const { loadConfig } = await import("./config.js");
    const { resolveSpec, listCatalog } = await import("./routing.js");

    const pi = makePi();
    const orchestrator = new Orchestrator(pi);
    orchestrator.cwd = agentDir;
    orchestrator.config = loadConfig(agentDir);
    registerEventHandlers(orchestrator);

    const withoutCodex = [
      { provider: "pp-flant-openai", id: "gpt-6-astra-pro" },
      { provider: "github-copilot", id: "gpt-6-astra" },
    ];
    const available = { models: withoutCodex };
    const ctx = {
      cwd: agentDir,
      modelRegistry: { getAvailable: () => available.models },
      ui: { notify: vi.fn() },
    };

    await emit(pi, "turn_start", {}, ctx);
    // Copilot is disabled, so only the LLM API serves the slot.
    expect(resolveSpec("gpt/astra:pro")).toBe("pp-flant-openai/gpt-6-astra-pro");

    writeAuth(agentDir, {
      "openai-codex": { type: "oauth", access: "token", refresh: "refresh", expires: Date.now() + 3_600_000 },
    });
    available.models = [...withoutCodex, { provider: "openai-codex", id: "gpt-6-astra" }];

    await emit(pi, "turn_start", {}, ctx);
    expect(listCatalog()).toContain("openai-codex/gpt-6-astra");
    // The ChatGPT subscription precedes the LLM API in the default order; it
    // has no pro variant, so the slot lands on its base model there.
    expect(resolveSpec("gpt/astra:pro")).toBe("openai-codex/gpt-6-astra");
  });

  it("keeps the catalog when the host reports no models yet", async () => {
    const agentDir = makeTempDir();
    process.env.PI_CODING_AGENT_DIR = agentDir;
    writeAuth(agentDir, {});
    writeGlobalProvidersConfig(agentDir, { codex: { enabled: true }, copilot: { enabled: false }, "claude-sub": { enabled: false } });
    vi.resetModules();

    const { registerEventHandlers } = await import("./event-handlers.js");
    const { Orchestrator } = await import("./orchestrator.js");
    const { getDefaultConfig, normalizeConfigDurations } = await import("./config.js");
    const { listCatalog } = await import("./routing.js");

    const pi = makePi();
    const orchestrator = new Orchestrator(pi);
    orchestrator.cwd = agentDir;
    orchestrator.config = normalizeConfigDurations(getDefaultConfig());
    registerEventHandlers(orchestrator);

    const available = { models: [{ provider: "pp-flant-openai", id: "gpt-6-astra-pro" }] as any[] };
    const ctx = {
      cwd: agentDir,
      modelRegistry: { getAvailable: () => available.models },
      ui: { notify: vi.fn() },
    };

    await emit(pi, "turn_start", {}, ctx);
    expect(listCatalog()).toContain("pp-flant-openai/gpt-6-astra-pro");

    writeAuth(agentDir, {
      "openai-codex": { type: "oauth", access: "token", refresh: "refresh", expires: Date.now() + 3_600_000 },
    });
    available.models = [];

    await emit(pi, "turn_start", {}, ctx);
    expect(listCatalog()).toContain("pp-flant-openai/gpt-6-astra-pro");
  });
});
