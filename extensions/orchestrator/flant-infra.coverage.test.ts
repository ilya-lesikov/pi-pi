import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const refreshGitHubCopilotTokenMock = vi.fn();
vi.mock("@earendil-works/pi-ai/oauth", () => ({
  refreshAnthropicToken: undefined,
  refreshGitHubCopilotToken: (...args: unknown[]) => refreshGitHubCopilotTokenMock(...args),
}));

const tempDirs: string[] = [];
const HOUR = 3_600_000;

function agentDir(auth?: Record<string, unknown> | string): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-pi-flant-cov-"));
  tempDirs.push(dir);
  if (auth !== undefined) writeFileSync(join(dir, "auth.json"), typeof auth === "string" ? auth : JSON.stringify(auth), "utf-8");
  return dir;
}

async function load(dir: string) {
  process.env.PI_CODING_AGENT_DIR = dir;
  vi.resetModules();
  return import("./flant-infra.js");
}

afterEach(() => {
  refreshGitHubCopilotTokenMock.mockReset();
  delete process.env.PI_CODING_AGENT_DIR;
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("resolveAgentDir", () => {
  it("expands a leading ~ and falls back to ~/.pi/agent", async () => {
    const mod = await load(agentDir());
    process.env.PI_CODING_AGENT_DIR = "~";
    expect(mod.resolveAgentDir()).toBe(homedir());
    process.env.PI_CODING_AGENT_DIR = "~/agent";
    expect(mod.resolveAgentDir()).toBe(`${homedir()}/agent`);
    delete process.env.PI_CODING_AGENT_DIR;
    expect(mod.resolveAgentDir()).toBe(join(homedir(), ".pi", "agent"));
  });
});

describe("stored OAuth tokens", () => {
  it("reads Copilot and ChatGPT tokens only while they are present and unexpired", async () => {
    const mod = await load(agentDir({
      "github-copilot": { access: "gho", expires: Date.now() + HOUR },
      "openai-codex": { access: "codex", expires: Date.now() + HOUR },
    }));
    expect(mod.readCopilotOAuthToken()).toBe("gho");
    expect(mod.readCodexOAuthToken()).toBe("codex");

    const expired = await load(agentDir({ "github-copilot": { access: "gho", expires: 1 }, "openai-codex": { access: "codex", expires: 1 } }));
    expect(expired.readCopilotOAuthToken()).toBeNull();
    expect(expired.readCodexOAuthToken()).toBeNull();

    const empty = await load(agentDir({ "github-copilot": { access: "" } }));
    expect(empty.readCopilotOAuthToken()).toBeNull();
    expect(empty.readCodexOAuthToken()).toBeNull();

    const corrupt = await load(agentDir("{not json"));
    expect(corrupt.readCopilotOAuthToken()).toBeNull();
    expect(corrupt.readClaudeOAuthToken()).toBeNull();

    const missing = await load(agentDir());
    expect(missing.readCopilotOAuthToken()).toBeNull();
  });

  it("counts an expired ChatGPT login as a credential only while it can be refreshed", async () => {
    expect((await load(agentDir({ "openai-codex": { access: "a" } }))).hasCodexCredential()).toBe(true);
    expect((await load(agentDir({ "openai-codex": { access: "a", expires: 1, refresh: "r" } }))).hasCodexCredential()).toBe(true);
    expect((await load(agentDir({ "openai-codex": { access: "a", expires: 1 } }))).hasCodexCredential()).toBe(false);
    expect((await load(agentDir({}))).hasCodexCredential()).toBe(false);
  });
});

describe("refreshCodexOAuthToken", () => {
  it("returns a fresh token as is and nothing without a login or refresh token", async () => {
    expect(await (await load(agentDir())).refreshCodexOAuthToken()).toBeNull();
    expect(await (await load(agentDir({}))).refreshCodexOAuthToken()).toBeNull();
    expect(await (await load(agentDir({ "openai-codex": { access: "live", expires: Date.now() + HOUR } }))).refreshCodexOAuthToken()).toBe("live");
    expect(await (await load(agentDir({ "openai-codex": { access: "old", expires: 1 } }))).refreshCodexOAuthToken()).toBeNull();
  });

  it("renews through pi's registry, and gives up when the registry throws", async () => {
    const dir = agentDir({ "openai-codex": { access: "old", refresh: "r", expires: 1 } });
    const mod = await load(dir);
    mod.setModelRegistry({
      getApiKeyForProvider: vi.fn(async () => {
        writeFileSync(join(dir, "auth.json"), JSON.stringify({ "openai-codex": { access: "new", refresh: "r2", expires: Date.now() + HOUR } }));
        return "key";
      }),
    });
    expect(await mod.refreshCodexOAuthToken()).toBe("new");

    const failing = await load(agentDir({ "openai-codex": { access: "old", refresh: "r", expires: 1 } }));
    failing.setModelRegistry({ getApiKeyForProvider: vi.fn(async () => { throw new Error("offline"); }) });
    expect(await failing.refreshCodexOAuthToken()).toBeNull();
  });

  it("rejects what the registry persisted when it is already expired", async () => {
    const dir = agentDir({ "openai-codex": { access: "old", refresh: "r", expires: 1 } });
    const mod = await load(dir);
    mod.setModelRegistry({ getApiKeyForProvider: vi.fn(async () => "key") });
    expect(await mod.refreshCodexOAuthToken()).toBeNull();
  });
});

describe("refreshCopilotOAuthToken with pi-ai's refresher", () => {
  const stale = () => ({ "github-copilot": { type: "oauth", access: "gho-old", refresh: "ghr", expires: 1, enterpriseUrl: "ghe.example" } });

  it("returns a fresh token without refreshing, and nothing without a refresh token", async () => {
    expect(await (await load(agentDir())).refreshCopilotOAuthToken()).toBeNull();
    expect(await (await load(agentDir({ "github-copilot": { access: "a", expires: Date.now() + HOUR } }))).refreshCopilotOAuthToken()).toBe("a");
    expect(await (await load(agentDir({ "github-copilot": { access: "a", expires: 1 } }))).refreshCopilotOAuthToken()).toBeNull();
    expect(refreshGitHubCopilotTokenMock).not.toHaveBeenCalled();
  });

  it("persists the refreshed credential, keeping the enterprise url", async () => {
    const dir = agentDir(stale());
    refreshGitHubCopilotTokenMock.mockResolvedValue({ access: "gho-new", refresh: "ghr2", expires: Date.now() + HOUR });
    const mod = await load(dir);
    expect(await mod.refreshCopilotOAuthToken()).toBe("gho-new");
    expect(refreshGitHubCopilotTokenMock).toHaveBeenCalledWith("ghr", "ghe.example");
    expect(JSON.parse(readFileSync(join(dir, "auth.json"), "utf-8"))["github-copilot"]).toMatchObject({ type: "oauth", access: "gho-new", refresh: "ghr2", enterpriseUrl: "ghe.example" });
  });

  it("keeps a fresher token another instance wrote while it refreshed", async () => {
    const dir = agentDir(stale());
    refreshGitHubCopilotTokenMock.mockImplementation(async () => {
      writeFileSync(join(dir, "auth.json"), JSON.stringify({ "github-copilot": { access: "gho-theirs", expires: Date.now() + HOUR } }));
      return { access: "gho-mine", refresh: "ghr2", expires: Date.now() + HOUR };
    });
    const mod = await load(dir);
    expect(await mod.refreshCopilotOAuthToken()).toBe("gho-theirs");
  });

  it("returns nothing when the refresh fails, and the new token even when it cannot be written", async () => {
    refreshGitHubCopilotTokenMock.mockRejectedValueOnce(new Error("revoked"));
    expect(await (await load(agentDir(stale()))).refreshCopilotOAuthToken()).toBeNull();

    const dir = agentDir(stale());
    refreshGitHubCopilotTokenMock.mockImplementation(async () => {
      writeFileSync(join(dir, "auth.json"), "{corrupt");
      return { access: "gho-new", refresh: "ghr2", expires: Date.now() + HOUR };
    });
    const mod = await load(dir);
    expect(await mod.refreshCopilotOAuthToken()).toBe("gho-new");
  });
});

describe("generateDisplayName", () => {
  it("joins version numbers and title-cases known tokens", async () => {
    const mod = await load(agentDir());
    expect(mod.generateDisplayName("claude-opus-4-8")).toBe("Claude Opus 4.8");
    expect(mod.generateDisplayName("qwen-api--ai-o3")).toBe("Qwen API AI O3");
  });
});
