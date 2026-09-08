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

  // The forced rotation cannot go through pi's registry: it refuses to refresh a
  // credential it still considers unexpired, which is exactly the revoked case.
  it("force-refreshes the Claude token over the token endpoint", async () => {
    const dir = makeAgentDir();
    const authPath = join(dir, "auth.json");
    writeFileSync(authPath, JSON.stringify({ anthropic: { type: "oauth", access: "sk-ant-oat01-live", refresh: "rt", expires: Date.now() + 3_600_000 } }), "utf-8");
    const mod = await loadFlantInfraModule(dir);
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ access_token: "sk-ant-oat01-http", refresh_token: "rt-http", expires_in: 3600 }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      await expect(mod.forceRefreshClaudeOAuthToken("sk-ant-oat01-live")).resolves.toEqual({ status: "rotated", token: "sk-ant-oat01-http" });
      const [url, req] = fetchMock.mock.calls[0] as unknown as [string, any];
      expect(url).toContain("/v1/oauth/token");
      expect(JSON.parse(req.body)).toMatchObject({ grant_type: "refresh_token", refresh_token: "rt" });
      const stored = JSON.parse(readFileSync(authPath, "utf-8")).anthropic;
      expect(stored).toMatchObject({ type: "oauth", access: "sk-ant-oat01-http", refresh: "rt-http" });
    } finally {
      vi.unstubAllGlobals();
    }
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
