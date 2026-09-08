import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { afterEach, describe, expect, it, vi } from "vitest";

const refreshAnthropicTokenMock = vi.fn();
vi.mock("@earendil-works/pi-ai/oauth", () => ({
  refreshAnthropicToken: (...args: unknown[]) => refreshAnthropicTokenMock(...args),
}));

const updateRegistryMock = vi.fn();
const setTierEnabledMock = vi.fn();
vi.mock("./model-registry.js", () => ({
  updateRegistryFromAvailableModels: (...args: unknown[]) => updateRegistryMock(...args),
  setTierEnabled: (...args: unknown[]) => setTierEnabledMock(...args),
  listRegisteredSpecs: () => [],
  isSubscriptionFallbackActive: () => false,
}));

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-pi-flant-more-"));
  tempDirs.push(dir);
  return dir;
}

async function loadModule(agentDir: string) {
  process.env.PI_CODING_AGENT_DIR = agentDir;
  vi.resetModules();
  return import("./flant-infra.js");
}

function stubFetch(handler: (url: string, opts: any) => any) {
  const fn = vi.fn(async (url: string, opts: any) => handler(url, opts));
  vi.stubGlobal("fetch", fn);
  return fn;
}

afterEach(() => {
  refreshAnthropicTokenMock.mockReset();
  updateRegistryMock.mockReset();
  setTierEnabledMock.mockReset();
  vi.unstubAllGlobals();
  delete process.env.PI_CODING_AGENT_DIR;
  delete process.env.FLANT_API_KEY;
  delete process.env.LLM_API_KEY;
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("discoverFlantModels", () => {
  it("dedupes and filters out or/ prefixed ids", async () => {
    const mod = await loadModule(makeTempDir());
    stubFetch(() => ({
      ok: true,
      status: 200,
      json: async () => ({ data: [{ id: "claude-opus-4-8" }, { id: "claude-opus-4-8" }, { id: "or/skip" }, { id: 5 }] }),
    }));
    await expect(mod.discoverFlantModels("k")).resolves.toEqual(["claude-opus-4-8"]);
  });

  it("throws on a non-ok HTTP status", async () => {
    const mod = await loadModule(makeTempDir());
    stubFetch(() => ({ ok: false, status: 503, json: async () => ({}) }));
    await expect(mod.discoverFlantModels("k")).rejects.toThrow("503");
  });
});

describe("fetchOpenRouterMetadata", () => {
  it("returns {} when no model ids map to OpenRouter ids", async () => {
    const mod = await loadModule(makeTempDir());
    const fn = stubFetch(() => ({ ok: true, status: 200, json: async () => ({ data: [] }) }));
    await expect(mod.fetchOpenRouterMetadata(["totally-unknown-model"])).resolves.toEqual({});
    expect(fn).not.toHaveBeenCalled();
  });

  it("maps diverse flant ids to openrouter ids and pulls metadata", async () => {
    const mod = await loadModule(makeTempDir());
    stubFetch(() => ({
      ok: true,
      status: 200,
      json: async () => ({
        data: [
          {
            id: "anthropic/claude-opus-4.8",
            name: "Claude Opus",
            context_length: 250000,
            top_provider: { max_completion_tokens: 64000 },
            pricing: { prompt: 1, completion: 2, input_cache_read: 3, input_cache_write: 4 },
            architecture: { modality: "text+image" },
          },
          { id: "openai/gpt-5", name: "GPT 5" },
          { id: "deepseek/deepseek-v3" },
          { id: "x-ai/grok-4" },
          { id: "qwen/qwen-3-coder" },
          { id: "perplexity/sonar-pro" },
          { id: "openai/o3-mini" },
          { id: "google/gemini-3.1-pro-preview" },
        ],
      }),
    }));
    const out = await mod.fetchOpenRouterMetadata([
      "claude-opus-4-8",
      "gpt-5",
      "deepseek-v3",
      "grok-4",
      "qwen-3-coder",
      "sonar-pro",
      "o3-mini",
      "gemini-3.1-pro",
      "unmapped-thing",
    ]);
    expect(out["claude-opus-4-8"]).toMatchObject({
      name: "Claude Opus",
      context_length: 250000,
      max_completion_tokens: 64000,
      modality: "text+image",
    });
    expect(out["claude-opus-4-8"].pricing).toEqual({ prompt: 1, completion: 2, cacheRead: 3, cacheWrite: 4 });
    expect(out["gpt-5"].name).toBe("GPT 5");
    expect(out["deepseek-v3"]).toBeTruthy();
    expect(out["grok-4"]).toBeTruthy();
    expect(out["qwen-3-coder"]).toBeTruthy();
    expect(out["sonar-pro"]).toBeTruthy();
    expect(out["o3-mini"]).toBeTruthy();
    expect(out["gemini-3.1-pro"]).toBeTruthy();
  });

  it("maps subscription-prefixed claude ids to their openrouter metadata", async () => {
    const mod = await loadModule(makeTempDir());
    stubFetch(() => ({
      ok: true,
      status: 200,
      json: async () => ({
        data: [
          {
            id: "anthropic/claude-fable-5.1",
            name: "Claude Fable 5.1",
            context_length: 1000000,
            top_provider: { max_completion_tokens: 128000 },
            pricing: { prompt: 1, completion: 2 },
            architecture: { modality: "text+image" },
          },
        ],
      }),
    }));
    // Keyed by the BARE id, which is what registerSubProvider looks up.
    const out = await mod.fetchOpenRouterMetadata(["sub/claude-fable-5-1"]);
    expect(out["claude-fable-5-1"]).toMatchObject({
      name: "Claude Fable 5.1",
      context_length: 1000000,
      max_completion_tokens: 128000,
    });
  });

  it("throws when OpenRouter returns a non-ok status", async () => {
    const mod = await loadModule(makeTempDir());
    stubFetch(() => ({ ok: false, status: 500, json: async () => ({}) }));
    await expect(mod.fetchOpenRouterMetadata(["claude-opus-4-8"])).rejects.toThrow("500");
  });
});

describe("probeSubscriptionCleared", () => {
  function writeAuth(dir: string) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "auth.json"),
      JSON.stringify({ anthropic: { type: "oauth", access: "sk-ant-oat01-x", refresh: "rt", expires: Date.now() + 3_600_000 } }),
      "utf-8",
    );
  }

  it("returns error when credentials are missing", async () => {
    const dir = makeTempDir();
    const mod = await loadModule(dir);
    const fn = stubFetch(() => ({ ok: true, status: 200 }));
    await expect(mod.probeSubscriptionCleared("sub/claude-haiku-4-5")).resolves.toBe("error");
    expect(fn).not.toHaveBeenCalled();
  });

  it("returns ok on a 200 response", async () => {
    const dir = makeTempDir();
    writeAuth(dir);
    process.env.LLM_API_KEY = "gw";
    const mod = await loadModule(dir);
    const fn = stubFetch(() => ({ ok: true, status: 200 }));
    await expect(mod.probeSubscriptionCleared("sub/claude-haiku-4-5")).resolves.toBe("ok");
    const body = JSON.parse(fn.mock.calls[0][1].body);
    expect(body.model).toBe("sub/claude-haiku-4-5");
  });

  it("returns rate_limited on a 429", async () => {
    const dir = makeTempDir();
    writeAuth(dir);
    process.env.LLM_API_KEY = "gw";
    const mod = await loadModule(dir);
    stubFetch(() => ({ ok: false, status: 429 }));
    await expect(mod.probeSubscriptionCleared("sub/claude-haiku-4-5")).resolves.toBe("rate_limited");
  });

  it("sends a billing-parity probe: full UA + CC identity + billing system[0], no temperature", async () => {
    const dir = makeTempDir();
    writeAuth(dir);
    process.env.LLM_API_KEY = "gw";
    const mod = await loadModule(dir);
    const fn = stubFetch(() => ({ ok: true, status: 200 }));
    await mod.probeSubscriptionCleared("sub/claude-haiku-4-5");
    const req = fn.mock.calls[0][1];
    // (i) full-form user-agent, not the bare claude-cli/1.0.0.
    expect(req.headers["user-agent"]).toMatch(/^claude-cli\/[0-9.]+ \(external, /);
    expect(req.headers["user-agent"]).not.toBe("claude-cli/1.0.0");
    const body = JSON.parse(req.body);
    // (ii) system[0] is the billing header entry.
    expect(body.system[0].text).toMatch(/^x-anthropic-billing-header:/);
    // (iii) the CC identity block is present (it is what gates injection).
    expect(body.system.some((e: any) => e.text.startsWith("You are Claude Code, Anthropic's official CLI for Claude."))).toBe(true);
    // (iv) no temperature key.
    expect(body.temperature).toBeUndefined();
  });

  it("treats a 400 extra-usage response as still-limited (item 10)", async () => {
    const dir = makeTempDir();
    writeAuth(dir);
    process.env.LLM_API_KEY = "gw";
    const mod = await loadModule(dir);
    stubFetch(() => ({ ok: false, status: 400, text: async () => "Third-party apps now draw from extra usage, not plan limits" }));
    await expect(mod.probeSubscriptionCleared("sub/claude-haiku-4-5")).resolves.toBe("rate_limited");
  });

  it("does not send temperature in the probe body (avoids the deprecated-temperature 400)", async () => {
    const dir = makeTempDir();
    writeAuth(dir);
    process.env.LLM_API_KEY = "gw";
    const mod = await loadModule(dir);
    const fn = stubFetch(() => ({ ok: true, status: 200 }));
    await mod.probeSubscriptionCleared("sub/claude-haiku-4-5");
    const body = JSON.parse(fn.mock.calls[0][1].body);
    expect(body.temperature).toBeUndefined();
  });

  it("returns error on an unexpected status and on a thrown fetch", async () => {
    const dir = makeTempDir();
    writeAuth(dir);
    process.env.LLM_API_KEY = "gw";
    const mod = await loadModule(dir);
    stubFetch(() => ({ ok: false, status: 500 }));
    await expect(mod.probeSubscriptionCleared("sub/claude-haiku-4-5")).resolves.toBe("error");
    stubFetch(() => { throw new Error("net"); });
    await expect(mod.probeSubscriptionCleared("sub/claude-haiku-4-5")).resolves.toBe("error");
  });

  // A REVOKED token stays clock-valid, so the expiry-gated refresh keeps handing
  // it back and the probe 401s forever: "error" every interval, switch-back
  // never fires, and the session is stuck on the fallback tier until the token
  // happens to expire on its own.
  it("rotates a rejected credential and retries instead of reporting a generic error", async () => {
    const dir = makeTempDir();
    writeAuth(dir);
    process.env.LLM_API_KEY = "gw";
    const mod = await loadModule(dir);
    refreshAnthropicTokenMock.mockResolvedValue({ access: "sk-ant-oat01-fresh", refresh: "rt2", expires: Date.now() + 3_600_000 });
    let call = 0;
    const fn = stubFetch(() => (++call === 1 ? { ok: false, status: 401 } : { ok: true, status: 200 }));
    await expect(mod.probeSubscriptionCleared("sub/claude-haiku-4-5")).resolves.toBe("ok");
    expect(refreshAnthropicTokenMock).toHaveBeenCalledWith("rt");
    expect(fn.mock.calls[1][1].headers.Authorization).toBe("Bearer sk-ant-oat01-fresh");
    expect(JSON.parse(readFileSync(join(dir, "auth.json"), "utf-8")).anthropic.access).toBe("sk-ant-oat01-fresh");
  });

  it("reports an error when the credential is still rejected after a rotation", async () => {
    const dir = makeTempDir();
    writeAuth(dir);
    process.env.LLM_API_KEY = "gw";
    const mod = await loadModule(dir);
    refreshAnthropicTokenMock.mockResolvedValue({ access: "sk-ant-oat01-fresh", refresh: "rt2", expires: Date.now() + 3_600_000 });
    const fn = stubFetch(() => ({ ok: false, status: 401 }));
    await expect(mod.probeSubscriptionCleared("sub/claude-haiku-4-5")).resolves.toBe("error");
    expect(fn).toHaveBeenCalledTimes(2);
  });
});

describe("forceRefreshClaudeOAuthToken", () => {
  function writeAuth(dir: string, access = "sk-ant-oat01-live", refresh: string | null = "rt") {
    mkdirSync(dir, { recursive: true });
    const anthropic: Record<string, unknown> = { type: "oauth", access, expires: Date.now() + 3_600_000 };
    if (refresh) anthropic.refresh = refresh;
    writeFileSync(join(dir, "auth.json"), JSON.stringify({ anthropic }), "utf-8");
  }

  const stored = (dir: string) => JSON.parse(readFileSync(join(dir, "auth.json"), "utf-8")).anthropic;

  it("rotates an unexpired credential and persists it", async () => {
    const dir = makeTempDir();
    writeAuth(dir);
    const mod = await loadModule(dir);
    refreshAnthropicTokenMock.mockResolvedValue({ access: "sk-ant-oat01-new", refresh: "rt2", expires: Date.now() + 3_600_000 });
    await expect(mod.forceRefreshClaudeOAuthToken("sk-ant-oat01-live")).resolves.toEqual({ status: "rotated", token: "sk-ant-oat01-new" });
    expect(stored(dir)).toMatchObject({ type: "oauth", access: "sk-ant-oat01-new", refresh: "rt2" });
    // Unlike refreshClaudeOAuthToken, which returns early on an unexpired token.
    await expect(mod.refreshClaudeOAuthToken()).resolves.toBe("sk-ant-oat01-new");
  });

  it("reuses a credential another party already rotated instead of rotating again", async () => {
    const dir = makeTempDir();
    writeAuth(dir, "sk-ant-oat01-rotated-elsewhere");
    const mod = await loadModule(dir);
    await expect(mod.forceRefreshClaudeOAuthToken("sk-ant-oat01-stale")).resolves.toEqual({ status: "rotated", token: "sk-ant-oat01-rotated-elsewhere" });
    expect(refreshAnthropicTokenMock).not.toHaveBeenCalled();
  });

  // Parallel workers all hit the same 401. Without coalescing, each would mint a
  // credential and invalidate the others' refresh token in turn.
  it("coalesces concurrent rotations of the same rejected token", async () => {
    const dir = makeTempDir();
    writeAuth(dir);
    const mod = await loadModule(dir);
    refreshAnthropicTokenMock.mockResolvedValue({ access: "sk-ant-oat01-new", refresh: "rt2", expires: Date.now() + 3_600_000 });
    const results = await Promise.all([
      mod.forceRefreshClaudeOAuthToken("sk-ant-oat01-live"),
      mod.forceRefreshClaudeOAuthToken("sk-ant-oat01-live"),
    ]);
    expect(results).toEqual([{ status: "rotated", token: "sk-ant-oat01-new" }, { status: "rotated", token: "sk-ant-oat01-new" }]);
    expect(refreshAnthropicTokenMock).toHaveBeenCalledTimes(1);
  });

  // A worker that failed on the OLD token after the rotation already landed must
  // adopt the new one, not be told to wait out a cooldown it cannot see.
  it("hands a straggler the fresh credential rather than throttling it", async () => {
    const dir = makeTempDir();
    writeAuth(dir);
    const mod = await loadModule(dir);
    refreshAnthropicTokenMock.mockResolvedValue({ access: "sk-ant-oat01-new", refresh: "rt2", expires: Date.now() + 3_600_000 });
    await mod.forceRefreshClaudeOAuthToken("sk-ant-oat01-live");
    await expect(mod.forceRefreshClaudeOAuthToken("sk-ant-oat01-live")).resolves.toEqual({ status: "rotated", token: "sk-ant-oat01-new" });
    expect(refreshAnthropicTokenMock).toHaveBeenCalledTimes(1);
  });

  // The 401 may come from the gateway key or a disabled account rather than a
  // revoked token. Rotating on every such failure would revoke the shared
  // credential out from under every other client, once per turn, forever.
  it("refuses to rotate again when the credential it just minted is rejected", async () => {
    const dir = makeTempDir();
    writeAuth(dir);
    const mod = await loadModule(dir);
    refreshAnthropicTokenMock.mockResolvedValue({ access: "sk-ant-oat01-new", refresh: "rt2", expires: Date.now() + 3_600_000 });
    await mod.forceRefreshClaudeOAuthToken("sk-ant-oat01-live");
    await expect(mod.forceRefreshClaudeOAuthToken("sk-ant-oat01-new")).resolves.toEqual({ status: "failed" });
    expect(refreshAnthropicTokenMock).toHaveBeenCalledTimes(1);
    expect(stored(dir).refresh).toBe("rt2");
  });

  it("reports failure when no refresh token is stored", async () => {
    const dir = makeTempDir();
    writeAuth(dir, "sk-ant-oat01-live", null);
    const mod = await loadModule(dir);
    await expect(mod.forceRefreshClaudeOAuthToken("sk-ant-oat01-live")).resolves.toEqual({ status: "failed" });
  });

  // The token is minted BEFORE the file lock is taken, so another process can
  // land its own rotation in between. Overwriting it would revoke a credential
  // that is already in use and restart the mutual-revocation loop.
  it("keeps a credential another process wrote from a different refresh chain", async () => {
    const dir = makeTempDir();
    writeAuth(dir);
    const mod = await loadModule(dir);
    refreshAnthropicTokenMock.mockImplementation(async () => {
      writeFileSync(
        join(dir, "auth.json"),
        JSON.stringify({ anthropic: { type: "oauth", access: "sk-ant-oat01-other", refresh: "rt-other", expires: Date.now() + 3_600_000 } }),
        "utf-8",
      );
      return { access: "sk-ant-oat01-ours", refresh: "rt-ours", expires: Date.now() + 3_600_000 };
    });
    await expect(mod.forceRefreshClaudeOAuthToken("sk-ant-oat01-live")).resolves.toEqual({ status: "rotated", token: "sk-ant-oat01-other" });
    expect(stored(dir)).toMatchObject({ access: "sk-ant-oat01-other", refresh: "rt-other" });
  });

  // The refresh token is single-use, so a grant that fails usually means another
  // instance consumed it first — and its replacement is already on disk. Failing
  // here would demote the session over a credential that works.
  it("adopts the persisted credential when the grant itself fails", async () => {
    const dir = makeTempDir();
    writeAuth(dir);
    const mod = await loadModule(dir);
    refreshAnthropicTokenMock.mockImplementation(async () => {
      writeFileSync(
        join(dir, "auth.json"),
        JSON.stringify({ anthropic: { type: "oauth", access: "sk-ant-oat01-other", refresh: "rt-other", expires: Date.now() + 3_600_000 } }),
        "utf-8",
      );
      throw new Error("invalid_grant: Refresh token not found or invalid");
    });
    await expect(mod.forceRefreshClaudeOAuthToken("sk-ant-oat01-live")).resolves.toEqual({ status: "rotated", token: "sk-ant-oat01-other" });
  });

  it("reports failure when the grant fails and nothing replaced the credential", async () => {
    const dir = makeTempDir();
    writeAuth(dir);
    const mod = await loadModule(dir);
    refreshAnthropicTokenMock.mockRejectedValue(new Error("invalid_grant"));
    await expect(mod.forceRefreshClaudeOAuthToken("sk-ant-oat01-live")).resolves.toEqual({ status: "failed" });
    expect(stored(dir)).toMatchObject({ access: "sk-ant-oat01-live", refresh: "rt" });
  });

  // The grant already consumed the previous refresh token, so a write that gives
  // up on a contended lock destroys the only usable credential.
  it("waits out a held lock rather than dropping the minted credential", async () => {
    const dir = makeTempDir();
    writeAuth(dir);
    const mod = await loadModule(dir);
    const release = await lockfile.lock(join(dir, "auth.json"), { stale: 10000 });
    let released = false;
    setTimeout(() => { released = true; void release(); }, 150);
    refreshAnthropicTokenMock.mockResolvedValue({ access: "sk-ant-oat01-new", refresh: "rt2", expires: Date.now() + 3_600_000 });
    await expect(mod.forceRefreshClaudeOAuthToken("sk-ant-oat01-live")).resolves.toEqual({ status: "rotated", token: "sk-ant-oat01-new" });
    expect(released).toBe(true);
    expect(stored(dir)).toMatchObject({ access: "sk-ant-oat01-new", refresh: "rt2" });
  });

  // The provider is rebound by re-reading auth.json, so an unpersisted token
  // would leave the REJECTED one registered while reporting success.
  it("reports failure when the rotated credential cannot be persisted", async () => {
    const dir = makeTempDir();
    writeAuth(dir);
    const mod = await loadModule(dir);
    refreshAnthropicTokenMock.mockImplementation(async () => {
      rmSync(dir, { recursive: true, force: true });
      writeFileSync(dir, "not a directory", "utf-8");
      return { access: "sk-ant-oat01-new", refresh: "rt2", expires: Date.now() + 3_600_000 };
    });
    await expect(mod.forceRefreshClaudeOAuthToken("sk-ant-oat01-live")).resolves.toEqual({ status: "failed" });
  });
});

describe("reviveSubscriptionCredential", () => {
  function writeAuth(dir: string) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "auth.json"),
      JSON.stringify({ anthropic: { type: "oauth", access: "sk-ant-oat01-live", refresh: "rt", expires: Date.now() + 3_600_000 } }),
      "utf-8",
    );
  }

  it("passes without rotating when the credential is accepted", async () => {
    const dir = makeTempDir();
    writeAuth(dir);
    process.env.LLM_API_KEY = "gw";
    const mod = await loadModule(dir);
    const fn = stubFetch(() => ({ ok: true, status: 200 }));
    await expect(mod.reviveSubscriptionCredential("pp-flant-anthropic-sub/sub/claude-haiku-4-5")).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(refreshAnthropicTokenMock).not.toHaveBeenCalled();
  });

  it("rotates a rejected credential", async () => {
    const dir = makeTempDir();
    writeAuth(dir);
    process.env.LLM_API_KEY = "gw";
    const mod = await loadModule(dir);
    refreshAnthropicTokenMock.mockResolvedValue({ access: "sk-ant-oat01-new", refresh: "rt2", expires: Date.now() + 3_600_000 });
    stubFetch(() => ({ ok: false, status: 401 }));
    await expect(mod.reviveSubscriptionCredential("sub/claude-haiku-4-5")).resolves.toBe("rotated");
    expect(refreshAnthropicTokenMock).toHaveBeenCalledTimes(1);
  });

  it("reports failure when a rejected credential cannot be renewed", async () => {
    const dir = makeTempDir();
    writeAuth(dir);
    process.env.LLM_API_KEY = "gw";
    const mod = await loadModule(dir);
    refreshAnthropicTokenMock.mockRejectedValue(new Error("refresh token revoked"));
    stubFetch(() => ({ ok: false, status: 401 }));
    await expect(mod.reviveSubscriptionCredential("sub/claude-haiku-4-5")).resolves.toBe("failed");
  });

  // A 401 the caller reports may be minutes old, and a rate limit does not
  // reject a credential at all. Rotating on either would revoke a working
  // token — the exact failure the whole change exists to stop.
  it("rotates nothing when the credential is currently accepted or merely limited", async () => {
    const dir = makeTempDir();
    writeAuth(dir);
    process.env.LLM_API_KEY = "gw";
    const mod = await loadModule(dir);
    stubFetch(() => ({ ok: false, status: 429 }));
    await expect(mod.reviveSubscriptionCredential("sub/claude-haiku-4-5")).resolves.toBe("ok");
    expect(refreshAnthropicTokenMock).not.toHaveBeenCalled();
  });

  // Reporting "ok" here would tell the caller to resume a turn that has just
  // been shown to be unverifiable, and the retry would land right back here.
  it("reports an unreachable gateway as inconclusive rather than working", async () => {
    const dir = makeTempDir();
    writeAuth(dir);
    process.env.LLM_API_KEY = "gw";
    const mod = await loadModule(dir);
    stubFetch(() => { throw new Error("ECONNRESET"); });
    await expect(mod.reviveSubscriptionCredential("sub/claude-haiku-4-5")).resolves.toBe("inconclusive");
    stubFetch(() => ({ ok: false, status: 503 }));
    await expect(mod.reviveSubscriptionCredential("sub/claude-haiku-4-5")).resolves.toBe("inconclusive");
    expect(refreshAnthropicTokenMock).not.toHaveBeenCalled();
  });
});

describe("recoverRejectedSubCredential", () => {
  function makePi() {
    const registered = new Map<string, any>();
    return {
      registered,
      registerProvider: vi.fn((n: string, c: any) => registered.set(n, c)),
      unregisterProvider: vi.fn((n: string) => registered.delete(n)),
    } as any;
  }

  async function registeredModule(dir: string) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "auth.json"),
      JSON.stringify({ anthropic: { type: "oauth", access: "sk-ant-oat01-live", refresh: "rt", expires: Date.now() + 3_600_000 } }),
      "utf-8",
    );
    process.env.LLM_API_KEY = "gw";
    const mod = await loadModule(dir);
    const pi = makePi();
    mod.registerFlantProviders(pi, ["claude-haiku-4-5"], {}, { subscription: true });
    return { mod, pi };
  }

  // The provider carries the token as a LITERAL apiKey, so a rotation that does
  // not re-register leaves every subsequent request on the rejected credential.
  it("rebinds the provider to the rotated token", async () => {
    const { mod, pi } = await registeredModule(makeTempDir());
    expect(pi.registered.get("pp-flant-anthropic-sub").apiKey).toBe("sk-ant-oat01-live");
    refreshAnthropicTokenMock.mockResolvedValue({ access: "sk-ant-oat01-new", refresh: "rt2", expires: Date.now() + 3_600_000 });
    await expect(mod.recoverRejectedSubCredential(pi)).resolves.toBe("rotated");
    expect(pi.registered.get("pp-flant-anthropic-sub").apiKey).toBe("sk-ant-oat01-new");
  });

  // The credential that failed is the one the PROVIDER holds, not whatever is on
  // disk now — which may already be another instance's replacement. Rotating
  // that one away is how two processes revoke each other in a loop.
  it("adopts a credential another instance wrote instead of rotating it away", async () => {
    const dir = makeTempDir();
    const { mod, pi } = await registeredModule(dir);
    writeFileSync(
      join(dir, "auth.json"),
      JSON.stringify({ anthropic: { type: "oauth", access: "sk-ant-oat01-other", refresh: "rt-other", expires: Date.now() + 3_600_000 } }),
      "utf-8",
    );
    await expect(mod.recoverRejectedSubCredential(pi)).resolves.toBe("rotated");
    expect(refreshAnthropicTokenMock).not.toHaveBeenCalled();
    expect(pi.registered.get("pp-flant-anthropic-sub").apiKey).toBe("sk-ant-oat01-other");
  });

  it("reports failure when the credential cannot be renewed at all", async () => {
    const { mod, pi } = await registeredModule(makeTempDir());
    refreshAnthropicTokenMock.mockRejectedValue(new Error("revoked"));
    await expect(mod.recoverRejectedSubCredential(pi)).resolves.toBe("failed");
  });
});

describe("updateFlantInfra", () => {
  function makePi() {
    const registered = new Map<string, unknown>();
    return {
      registered,
      registerProvider: vi.fn((n: string, c: unknown) => registered.set(n, c)),
      unregisterProvider: vi.fn((n: string) => registered.delete(n)),
    } as any;
  }

  it("fails when no cache and no FLANT_API_KEY", async () => {
    const mod = await loadModule(makeTempDir());
    const res = await mod.updateFlantInfra(makePi());
    expect(res.ok).toBe(false);
    expect(res.error).toContain("FLANT_API_KEY");
  });

  it("discovers models, saves cache, and registers providers on success", async () => {
    const dir = makeTempDir();
    process.env.FLANT_API_KEY = "flant-k";
    const mod = await loadModule(dir);
    stubFetch((url: string) => {
      if (url.includes("llm-api.flant.ru/v1/models")) {
        return { ok: true, status: 200, json: async () => ({ data: [{ id: "claude-opus-4-8" }, { id: "gpt-5" }] }) };
      }
      if (url.includes("openrouter.ai")) {
        return { ok: true, status: 200, json: async () => ({ data: [] }) };
      }
      throw new Error(`unexpected ${url}`);
    });
    const pi = makePi();
    const res = await mod.updateFlantInfra(pi);
    expect(res.ok).toBe(true);
    expect(res.models).toContain("claude-opus-4-8");
    expect([...pi.registered.keys()]).toEqual(["pp-flant-openai"]);
  });

  it("serves a fresh cache without re-fetching by default", async () => {
    const dir = makeTempDir();
    const cacheDir = join(dir, "extensions", "pp", "cache");
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(
      join(cacheDir, "flant-models.json"),
      JSON.stringify({
        enabled: true,
        cacheTTLDays: 7,
        lastUpdated: new Date().toISOString(),
        cachedFlantModels: ["claude-opus-4-8"],
        // Non-empty: a cache with no metadata carries no context window or
        // pricing and is deliberately never served.
        cachedOpenRouterData: { "claude-opus-4-8": { context_length: 200_000 } },
      }),
      "utf-8",
    );
    process.env.FLANT_API_KEY = "flant-k";
    const mod = await loadModule(dir);
    const fetchFn = stubFetch(() => { throw new Error("should not fetch"); });
    const res = await mod.updateFlantInfra(makePi());
    expect(res.ok).toBe(true);
    expect(res.models).toEqual(["claude-opus-4-8"]);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("force bypasses a fresh cache and re-fetches the model list", async () => {
    const dir = makeTempDir();
    const cacheDir = join(dir, "extensions", "pp", "cache");
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(
      join(cacheDir, "flant-models.json"),
      JSON.stringify({
        enabled: true,
        cacheTTLDays: 7,
        lastUpdated: new Date().toISOString(),
        cachedFlantModels: ["claude-opus-4-8"],
        cachedOpenRouterData: {},
      }),
      "utf-8",
    );
    process.env.FLANT_API_KEY = "flant-k";
    const mod = await loadModule(dir);
    stubFetch((url: string) => {
      if (url.includes("llm-api.flant.ru/v1/models")) {
        return { ok: true, status: 200, json: async () => ({ data: [{ id: "sub/claude-fable-5" }, { id: "claude-fable-5" }] }) };
      }
      if (url.includes("openrouter.ai")) {
        return { ok: true, status: 200, json: async () => ({ data: [] }) };
      }
      throw new Error(`unexpected ${url}`);
    });
    const res = await mod.updateFlantInfra(makePi(), { force: true });
    expect(res.ok).toBe(true);
    expect(res.models).toContain("sub/claude-fable-5");
  });

  // A forced refresh inside the TTL keeps a fresh timestamp, so declining to
  // re-stamp is not enough: empty metadata has to invalidate the cache outright
  // or every model keeps the fallback context window and zero cost until it ages out.
  it("invalidates the cache when metadata comes back empty", async () => {
    const dir = makeTempDir();
    const cacheDir = join(dir, "extensions", "pp", "cache");
    mkdirSync(cacheDir, { recursive: true });
    const cachePath = join(cacheDir, "flant-models.json");
    writeFileSync(
      cachePath,
      JSON.stringify({
        enabled: true,
        cacheTTLDays: 7,
        lastUpdated: new Date().toISOString(),
        cachedFlantModels: ["claude-opus-4-8"],
        cachedOpenRouterData: {},
      }),
      "utf-8",
    );
    process.env.FLANT_API_KEY = "flant-k";
    const mod = await loadModule(dir);
    stubFetch((url: string) => {
      if (url.includes("llm-api.flant.ru/v1/models")) {
        return { ok: true, status: 200, json: async () => ({ data: [{ id: "claude-opus-4-8" }] }) };
      }
      if (url.includes("openrouter.ai")) return { ok: false, status: 500, json: async () => ({}) };
      throw new Error(`unexpected ${url}`);
    });
    const res = await mod.updateFlantInfra(makePi(), { force: true });
    expect(res.ok).toBe(true);
    expect(JSON.parse(readFileSync(cachePath, "utf-8")).lastUpdated).toBeNull();
  });

  // A metadata fetch that succeeds but matches no model is as empty as a failed
  // one — stamping it would serve fallback windows and zero pricing for a week.
  it("invalidates the cache when metadata fetches successfully but matches nothing", async () => {
    const dir = makeTempDir();
    const cacheDir = join(dir, "extensions", "pp", "cache");
    mkdirSync(cacheDir, { recursive: true });
    const cachePath = join(cacheDir, "flant-models.json");
    writeFileSync(
      cachePath,
      JSON.stringify({
        enabled: true,
        cacheTTLDays: 7,
        lastUpdated: new Date().toISOString(),
        cachedFlantModels: ["claude-opus-4-8"],
        cachedOpenRouterData: {},
      }),
      "utf-8",
    );
    process.env.FLANT_API_KEY = "flant-k";
    const mod = await loadModule(dir);
    stubFetch((url: string) => {
      if (url.includes("llm-api.flant.ru/v1/models")) {
        return { ok: true, status: 200, json: async () => ({ data: [{ id: "claude-opus-4-8" }] }) };
      }
      if (url.includes("openrouter.ai")) return { ok: true, status: 200, json: async () => ({ data: [] }) };
      throw new Error(`unexpected ${url}`);
    });
    const res = await mod.updateFlantInfra(makePi(), { force: true });
    expect(res.ok).toBe(true);
    expect(JSON.parse(readFileSync(cachePath, "utf-8")).lastUpdated).toBeNull();
  });

  // A cache written before sub/ ids were mapped holds metadata for every model
  // EXCEPT Claude, so it looks valid while pinning that whole family to the
  // fallback context window until the TTL expires.
  it("refetches when a mappable cached model has no metadata entry", async () => {
    const dir = makeTempDir();
    const cacheDir = join(dir, "extensions", "pp", "cache");
    mkdirSync(cacheDir, { recursive: true });
    const cachePath = join(cacheDir, "flant-models.json");
    writeFileSync(
      cachePath,
      JSON.stringify({
        lastUpdated: new Date().toISOString(),
        cachedFlantModels: ["gpt-5", "sub/claude-opus-4-8"],
        cachedOpenRouterData: { "gpt-5": { name: "GPT 5", context_length: 400000, max_completion_tokens: 32000, pricing: { prompt: 0, completion: 0, cacheRead: 0, cacheWrite: 0 }, modality: "text" } },
      }),
      "utf-8",
    );
    process.env.FLANT_API_KEY = "flant-k";
    const mod = await loadModule(dir);
    const seen: string[] = [];
    stubFetch((url: string) => {
      seen.push(url);
      if (url.includes("llm-api.flant.ru/v1/models")) {
        return { ok: true, status: 200, json: async () => ({ data: [{ id: "gpt-5" }, { id: "sub/claude-opus-4-8" }] }) };
      }
      if (url.includes("openrouter.ai")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: [{ id: "anthropic/claude-opus-4.8", name: "Opus", context_length: 1000000 }, { id: "openai/gpt-5", name: "GPT 5" }] }),
        };
      }
      throw new Error(`unexpected ${url}`);
    });
    const res = await mod.updateFlantInfra(makePi());
    expect(res.ok).toBe(true);
    expect(seen.some((u) => u.includes("openrouter.ai"))).toBe(true);
    const written = JSON.parse(readFileSync(cachePath, "utf-8"));
    expect(written.cachedOpenRouterData["claude-opus-4-8"].context_length).toBe(1_000_000);
  });

  // OpenRouter simply does not publish some gateway models. Re-invalidating on
  // their permanently missing entries refetched the whole catalog on every
  // startup, so the TTL never held.
  it("serves the cache again after a fetch that could not resolve a model", async () => {
    const dir = makeTempDir();
    const cacheDir = join(dir, "extensions", "pp", "cache");
    mkdirSync(cacheDir, { recursive: true });
    const cachePath = join(cacheDir, "flant-models.json");
    process.env.FLANT_API_KEY = "flant-k";
    const mod = await loadModule(dir);
    const fetchFn = stubFetch((url: string) => {
      if (url.includes("llm-api.flant.ru/v1/models")) {
        return { ok: true, status: 200, json: async () => ({ data: [{ id: "gpt-5" }, { id: "qwen3.8-27b" }] }) };
      }
      if (url.includes("openrouter.ai")) {
        return { ok: true, status: 200, json: async () => ({ data: [{ id: "openai/gpt-5", name: "GPT 5", context_length: 400000 }] }) };
      }
      throw new Error(`unexpected ${url}`);
    });

    expect((await mod.updateFlantInfra(makePi())).ok).toBe(true);
    expect(JSON.parse(readFileSync(cachePath, "utf-8")).unmappedModels).toEqual({ "qwen3.8-27b": "qwen/qwen-3.8-27b" });

    const callsAfterFirst = fetchFn.mock.calls.length;
    expect((await mod.updateFlantInfra(makePi())).ok).toBe(true);
    expect(fetchFn.mock.calls.length).toBe(callsAfterFirst);
  });

  // A mapping change makes the recorded id stale, so the model deserves
  // another lookup rather than being skipped forever.
  it("refetches when a model recorded as unresolvable now maps elsewhere", async () => {
    const dir = makeTempDir();
    const cacheDir = join(dir, "extensions", "pp", "cache");
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(
      join(cacheDir, "flant-models.json"),
      JSON.stringify({
        lastUpdated: new Date().toISOString(),
        cachedFlantModels: ["gpt-5", "qwen3.8-27b"],
        cachedOpenRouterData: { "gpt-5": { name: "GPT 5", context_length: 400000, max_completion_tokens: 32000, pricing: { prompt: 0, completion: 0, cacheRead: 0, cacheWrite: 0 }, modality: "text" } },
        unmappedModels: { "qwen3.8-27b": "qwen/some-older-guess" },
      }),
      "utf-8",
    );
    process.env.FLANT_API_KEY = "flant-k";
    const mod = await loadModule(dir);
    const seen: string[] = [];
    stubFetch((url: string) => {
      seen.push(url);
      if (url.includes("llm-api.flant.ru/v1/models")) {
        return { ok: true, status: 200, json: async () => ({ data: [{ id: "gpt-5" }, { id: "qwen3.8-27b" }] }) };
      }
      if (url.includes("openrouter.ai")) {
        return { ok: true, status: 200, json: async () => ({ data: [{ id: "openai/gpt-5", name: "GPT 5", context_length: 400000 }] }) };
      }
      throw new Error(`unexpected ${url}`);
    });

    expect((await mod.updateFlantInfra(makePi())).ok).toBe(true);
    expect(seen.some((u) => u.includes("openrouter.ai"))).toBe(true);
  });

  // A metadata fetch that never reached OpenRouter proves nothing about which
  // models it publishes, so it must not silence the retry for the whole TTL.
  it("refetches after a metadata fetch failed over an older cache", async () => {
    const dir = makeTempDir();
    const cacheDir = join(dir, "extensions", "pp", "cache");
    mkdirSync(cacheDir, { recursive: true });
    const cachePath = join(cacheDir, "flant-models.json");
    writeFileSync(
      cachePath,
      JSON.stringify({
        lastUpdated: null,
        cachedFlantModels: ["gpt-5"],
        cachedOpenRouterData: { "gpt-5": { name: "GPT 5", context_length: 400000, max_completion_tokens: 32000, pricing: { prompt: 0, completion: 0, cacheRead: 0, cacheWrite: 0 }, modality: "text" } },
      }),
      "utf-8",
    );
    process.env.FLANT_API_KEY = "flant-k";
    const mod = await loadModule(dir);
    let openRouterCalls = 0;
    stubFetch((url: string) => {
      if (url.includes("llm-api.flant.ru/v1/models")) {
        return { ok: true, status: 200, json: async () => ({ data: [{ id: "gpt-5" }, { id: "gpt-6" }] }) };
      }
      if (url.includes("openrouter.ai")) {
        openRouterCalls += 1;
        throw new Error("openrouter down");
      }
      throw new Error(`unexpected ${url}`);
    });

    expect((await mod.updateFlantInfra(makePi())).ok).toBe(true);
    const written = JSON.parse(readFileSync(cachePath, "utf-8"));
    expect(written.unmappedModels ?? null).toBeNull();

    expect((await mod.updateFlantInfra(makePi())).ok).toBe(true);
    expect(openRouterCalls).toBe(2);
  });

  it("falls back to cached models when discovery throws", async () => {
    const dir = makeTempDir();
    const cacheDir = join(dir, "extensions", "pp", "cache");
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(
      join(cacheDir, "flant-models.json"),
      JSON.stringify({
        enabled: true,
        cachedFlantModels: ["claude-opus-4-8"],
        cachedOpenRouterData: {},
      }),
      "utf-8",
    );
    process.env.FLANT_API_KEY = "flant-k";
    const mod = await loadModule(dir);
    stubFetch(() => { throw new Error("discovery down"); });
    const res = await mod.updateFlantInfra(makePi());
    expect(res.ok).toBe(true);
    expect(res.models).toEqual(["claude-opus-4-8"]);
  });
});

describe("initFlantSync / initFlantOnStartup", () => {
  function makePi() {
    return { registerProvider: vi.fn(), unregisterProvider: vi.fn() } as any;
  }

  it("initFlantSync is a no-op when disabled", async () => {
    const mod = await loadModule(makeTempDir());
    const pi = makePi();
    mod.initFlantSync(pi);
    expect(pi.registerProvider).not.toHaveBeenCalled();
    expect(mod.getFlantGeneratedConfig()).toBeNull();
  });

  it("initFlantSync registers from cache when enabled", async () => {
    const dir = makeTempDir();
    const cfgDir = join(dir, "extensions", "pp");
    mkdirSync(cfgDir, { recursive: true });
    // Durable `enabled` now lives in scoped config (item 8).
    writeFileSync(join(cfgDir, "config.json"), JSON.stringify({ flant: { enabled: true } }), "utf-8");
    const cacheDir = join(cfgDir, "cache");
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(
      join(cacheDir, "flant-models.json"),
      JSON.stringify({ cachedFlantModels: ["sub/claude-opus-4-8", "gpt-5"], cachedOpenRouterData: {} }),
      "utf-8",
    );
    const mod = await loadModule(dir);
    const pi = makePi();
    mod.initFlantSync(pi);
    expect(pi.registerProvider).toHaveBeenCalled();
    expect(mod.getFlantGeneratedConfig()).not.toBeNull();
  });

  it("initFlantOnStartup is a no-op when disabled", async () => {
    const mod = await loadModule(makeTempDir());
    const pi = makePi();
    await mod.initFlantOnStartup(pi);
    expect(pi.registerProvider).not.toHaveBeenCalled();
  });

  it("initFlantOnStartup refreshes an expired subscription token before computing tiers", async () => {
    const dir = makeTempDir();
    const cfgDir = join(dir, "extensions", "pp");
    mkdirSync(cfgDir, { recursive: true });
    writeFileSync(join(cfgDir, "config.json"), JSON.stringify({ flant: { enabled: true, autoUpdate: false, subscription: true } }), "utf-8");
    writeFileSync(
      join(dir, "auth.json"),
      JSON.stringify({ anthropic: { type: "oauth", access: "stale", refresh: "rt", expires: Date.now() - 1000 } }),
      "utf-8",
    );
    process.env.LLM_API_KEY = "gw";
    refreshAnthropicTokenMock.mockResolvedValue({ access: "fresh", refresh: "rt2", expires: Date.now() + 3_600_000 });
    // No cache is written, so this settings shape bootstraps one through a real
    // discovery request; keep it off the network.
    stubFetch(() => ({ ok: true, status: 200, json: async () => ({ data: [] }) }));

    const mod = await loadModule(dir);
    await mod.initFlantOnStartup(makePi());

    // Reading the stored token before refreshing it would classify the tier as
    // unavailable, and nothing re-syncs afterwards.
    expect(refreshAnthropicTokenMock).toHaveBeenCalled();
    expect(setTierEnabledMock).toHaveBeenCalledWith(expect.objectContaining({ "flant-sub": true }));
  });

  it("initFlantOnStartup skips update when autoUpdate is off", async () => {
    const dir = makeTempDir();
    const cfgDir = join(dir, "extensions", "pp");
    mkdirSync(cfgDir, { recursive: true });
    writeFileSync(join(cfgDir, "config.json"), JSON.stringify({ flant: { enabled: true, autoUpdate: false, subscription: false } }), "utf-8");
    const mod = await loadModule(dir);
    const pi = makePi();
    await mod.initFlantOnStartup(pi);
    expect(pi.registerProvider).not.toHaveBeenCalled();
  });

  it("initFlantOnStartup registers from cache when autoUpdate is off but flant is enabled", async () => {
    const dir = makeTempDir();
    const cfgDir = join(dir, "extensions", "pp");
    mkdirSync(cfgDir, { recursive: true });
    // Global disables; a PROJECT override enables with autoUpdate off — the
    // provider must still register from the cached model list (finding 3).
    writeFileSync(join(cfgDir, "config.json"), JSON.stringify({ flant: { enabled: false } }), "utf-8");
    const cacheDir = join(cfgDir, "cache");
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(
      join(cacheDir, "flant-models.json"),
      JSON.stringify({ cachedFlantModels: ["sub/claude-opus-4-8", "gpt-5"], cachedOpenRouterData: {} }),
      "utf-8",
    );
    const projCwd = makeTempDir();
    mkdirSync(join(projCwd, ".pp"), { recursive: true });
    writeFileSync(join(projCwd, ".pp", "config.json"), JSON.stringify({ flant: { enabled: true, autoUpdate: false, subscription: false } }), "utf-8");

    const mod = await loadModule(dir);
    const pi = makePi();
    await mod.initFlantOnStartup(pi, projCwd);
    expect(pi.registerProvider).toHaveBeenCalled();
    expect(mod.getFlantGeneratedConfig()).not.toBeNull();
  });

  it("initFlantSync honors a project enable via the shared root cwd", async () => {
    const dir = makeTempDir();
    const cfgDir = join(dir, "extensions", "pp");
    mkdirSync(cfgDir, { recursive: true });
    // Global disables flant; the project (root cwd) ENABLES it with a cache.
    writeFileSync(join(cfgDir, "config.json"), JSON.stringify({ flant: { enabled: false } }), "utf-8");
    const cacheDir = join(cfgDir, "cache");
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(
      join(cacheDir, "flant-models.json"),
      JSON.stringify({ cachedFlantModels: ["sub/claude-opus-4-8", "gpt-5"], cachedOpenRouterData: {} }),
      "utf-8",
    );
    const projCwd = makeTempDir();
    mkdirSync(join(projCwd, ".pp"), { recursive: true });
    writeFileSync(join(projCwd, ".pp", "config.json"), JSON.stringify({ flant: { enabled: true } }), "utf-8");

    const mod = await loadModule(dir);
    const pi = makePi();
    // Global-only read would register nothing; the shared root cwd must bind.
    mod.initFlantSync(pi, projCwd);
    expect(pi.registerProvider).toHaveBeenCalledWith("pp-flant-openai", expect.anything());
  });

  it("a project override disabling flant unregisters providers at session_start", async () => {
    const dir = makeTempDir();
    // Global enables flant + subscription (what initFlantSync would register).
    const cfgDir = join(dir, "extensions", "pp");
    mkdirSync(cfgDir, { recursive: true });
    writeFileSync(join(cfgDir, "config.json"), JSON.stringify({ flant: { enabled: true, subscription: true } }), "utf-8");
    // Project (cwd/.pp) DISABLES flant.
    const projCwd = makeTempDir();
    mkdirSync(join(projCwd, ".pp"), { recursive: true });
    writeFileSync(join(projCwd, ".pp", "config.json"), JSON.stringify({ flant: { enabled: false } }), "utf-8");

    const mod = await loadModule(dir);
    const pi = makePi();
    await mod.initFlantOnStartup(pi, projCwd);
    // Honor the project override: no registration, providers unregistered.
    expect(pi.registerProvider).not.toHaveBeenCalled();
    expect(pi.unregisterProvider).toHaveBeenCalledWith("pp-flant-anthropic-sub");
  });
});

describe("unregisterFlantProviders", () => {
  it("unregisters all three providers via the passed pi", async () => {
    const mod = await loadModule(makeTempDir());
    const pi = { unregisterProvider: vi.fn(), registerProvider: vi.fn() } as any;
    mod.unregisterFlantProviders(pi);
    expect(pi.unregisterProvider).toHaveBeenCalledWith("pp-flant-anthropic");
    expect(pi.unregisterProvider).toHaveBeenCalledWith("pp-flant-openai");
    expect(pi.unregisterProvider).toHaveBeenCalledWith("pp-flant-anthropic-sub");
  });

  it("is a no-op when no pi is set", async () => {
    const mod = await loadModule(makeTempDir());
    expect(() => mod.unregisterFlantProviders()).not.toThrow();
  });
});
