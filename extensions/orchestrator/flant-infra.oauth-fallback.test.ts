import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// The standalone pi binary bundles `@earendil-works/pi-ai/oauth` as an EMPTY
// module, so the named refresh functions are undefined at runtime there.
vi.mock("@earendil-works/pi-ai/oauth", () => ({ refreshAnthropicToken: undefined, refreshGitHubCopilotToken: undefined }));

const tempDirs: string[] = [];

function makeAgentDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-pi-flant-oauth-"));
  tempDirs.push(dir);
  mkdirSync(dir, { recursive: true });
  return dir;
}

async function loadFlantInfraModule(agentDir: string) {
  process.env.PI_CODING_AGENT_DIR = agentDir;
  vi.resetModules();
  return import("./flant-infra.js");
}

afterEach(() => {
  delete process.env.PI_CODING_AGENT_DIR;
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("oauth refresh without the pi-ai/oauth module", () => {
  it("refreshes the Claude token through pi's model registry and returns the persisted token", async () => {
    const dir = makeAgentDir();
    const authPath = join(dir, "auth.json");
    writeFileSync(authPath, JSON.stringify({ anthropic: { type: "oauth", access: "sk-ant-oat01-old", refresh: "rt-old", expires: Date.now() - 1000 } }), "utf-8");
    const mod = await loadFlantInfraModule(dir);
    const registry = {
      getApiKeyForProvider: vi.fn(async (provider: string) => {
        expect(provider).toBe("anthropic");
        const current = JSON.parse(readFileSync(authPath, "utf-8"));
        current.anthropic = { type: "oauth", access: "sk-ant-oat01-new", refresh: "rt-new", expires: Date.now() + 3_600_000 };
        writeFileSync(authPath, JSON.stringify(current), "utf-8");
        return "sk-ant-oat01-new";
      }),
    };
    mod.setModelRegistry(registry);
    await expect(mod.refreshClaudeOAuthToken()).resolves.toBe("sk-ant-oat01-new");
    expect(registry.getApiKeyForProvider).toHaveBeenCalledTimes(1);
    expect(mod.readClaudeOAuthToken()).toBe("sk-ant-oat01-new");
  });

  it("returns null when the registry cannot produce a token", async () => {
    const dir = makeAgentDir();
    writeFileSync(join(dir, "auth.json"), JSON.stringify({ anthropic: { type: "oauth", access: "sk-ant-oat01-old", refresh: "rt-old", expires: Date.now() - 1000 } }), "utf-8");
    const mod = await loadFlantInfraModule(dir);
    mod.setModelRegistry({ getApiKeyForProvider: vi.fn(async () => undefined) });
    await expect(mod.refreshClaudeOAuthToken()).resolves.toBeNull();
    mod.setModelRegistry(null);
    await expect(mod.refreshClaudeOAuthToken()).resolves.toBeNull();
  });

  it("refreshes the Copilot token through pi's model registry", async () => {
    const dir = makeAgentDir();
    const authPath = join(dir, "auth.json");
    writeFileSync(authPath, JSON.stringify({ "github-copilot": { type: "oauth", access: "gho-old", refresh: "ghr-old", expires: Date.now() - 1000 } }), "utf-8");
    const mod = await loadFlantInfraModule(dir);
    mod.setModelRegistry({
      getApiKeyForProvider: vi.fn(async (provider: string) => {
        expect(provider).toBe("github-copilot");
        const current = JSON.parse(readFileSync(authPath, "utf-8"));
        current["github-copilot"] = { type: "oauth", access: "gho-new", refresh: "ghr-old", expires: Date.now() + 3_600_000 };
        writeFileSync(authPath, JSON.stringify(current), "utf-8");
        return "copilot-api-token";
      }),
    });
    await expect(mod.refreshCopilotOAuthToken()).resolves.toBe("gho-new");
    expect(mod.readCopilotOAuthToken()).toBe("gho-new");
  });
});
