import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import * as piAiOAuth from "@earendil-works/pi-ai/oauth";
import { getModel, getModels } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { readScopedRoutingSettings, type RoutingSettings } from "./config.js";
import { DIRECT_SUB_PROVIDER, GATEWAY_SUB_MODEL_PREFIX, GATEWAY_SUB_PROVIDER, LLM_API_PROVIDER, CODEX_PROVIDER as CODEX, COPILOT_PROVIDER } from "./routing.js";
import { getLogger } from "./log.js";
import { buildUserAgent, injectBillingHeader, CC_IDENTITY } from "./billing-spoof.js";

/**
 * The token refreshers pi-ai used to export.
 *
 * pi >= 0.84 ships this subpath as an empty module — the binary bundles it that
 * way and the package publishes `export {}` — so both are absent wherever pi-pi
 * actually runs and every call site falls through to pi's own registry. They
 * are still read through here rather than deleted because an older pi-ai on the
 * same peer range does export them, and that path rotates and persists the
 * credential itself.
 */
const oauth = piAiOAuth as unknown as {
  refreshAnthropicToken?: (refreshToken: string) => Promise<{ refresh: string; access: string; expires: number }>;
  refreshGitHubCopilotToken?: (refreshToken: string, enterpriseUrl?: string) => Promise<{ refresh: string; access: string; expires: number; enterpriseUrl?: string }>;
};

export interface OpenRouterModelData {
  name: string;
  context_length: number;
  max_completion_tokens: number;
  pricing: {
    prompt: number;
    completion: number;
    cacheRead: number;
    cacheWrite: number;
  };
  modality: string;
}

/** The LLM API model catalog cached between sessions. */
export interface LlmApiCache {
  lastUpdated: string | null;
  cachedFlantModels: string[] | null;
  cachedOpenRouterData: Record<string, OpenRouterModelData> | null;
  /**
   * Models the last metadata fetch could map but OpenRouter does not publish,
   * keyed by bare gateway id with the OpenRouter id that was tried. Without
   * this record their permanently missing entries would re-invalidate the cache
   * on every startup, so the TTL would never hold.
   */
  unmappedModels: Record<string, string> | null;
}

const GEMINI_MAP: Record<string, string> = {
  "gemini-3-flash": "google/gemini-3.0-flash",
  "gemini-3.1-flash-lite": "google/gemini-3.1-flash-lite-preview",
  "gemini-3.1-pro": "google/gemini-3.1-pro-preview",
};

export function resolveAgentDir(): string {
  const envKey = "PI_CODING_AGENT_DIR";
  const envDir = process.env[envKey];
  if (envDir) {
    if (envDir === "~") return homedir();
    if (envDir.startsWith("~/")) return homedir() + envDir.slice(1);
    return envDir;
  }
  return join(homedir(), ".pi", "agent");
}

const SETTINGS_DIR = join(resolveAgentDir(), "extensions", "pp", "cache");
const SETTINGS_PATH = join(SETTINGS_DIR, "flant-models.json");
/** Provider name for the personal-subscription Claude routing. */
export const SUB_PROVIDER = GATEWAY_SUB_PROVIDER;

/** pi's built-in provider for a personal ChatGPT Plus/Pro subscription. */
export const CODEX_PROVIDER = CODEX;

const CLAUDE_REFRESH_MARGIN_MS = 5 * 60_000;
const FORCED_REFRESH_COOLDOWN_MS = 60_000;
const ANTHROPIC_TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
// Anthropic's public Claude Code OAuth client id, identical to the one pi-ai
// uses; the refresh grant is unauthenticated beyond it.
const ANTHROPIC_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";

/** Prefix the gateway expects for personal-subscription Claude models. */
export const SUB_MODEL_PREFIX = GATEWAY_SUB_MODEL_PREFIX;

/**
 * Read the Claude OAuth access token persisted by pi's built-in `anthropic`
 * OAuth provider. Returns null when absent or expired. The gateway uses this
 * token (forwarded as `Authorization: Bearer ...`) to bill the user's personal
 * Claude subscription; pi-ai automatically adds the Claude Code identity
 * headers because the token has the `sk-ant-oat` prefix.
 */
export function readClaudeOAuthToken(): string | null {
  const token = readStoredClaudeOAuthToken();
  if (!token || token.expired) return null;
  return token.access;
}

// The persisted access token WITH its expiry state, so provider registration can
// fall back to an expired token. The registration must exist before pi restores
// the session's model (which happens at extension load, ahead of any refresh);
// without it the restore fails and the session lands on an unrelated model.
function readStoredClaudeOAuthToken(): { access: string; expired: boolean } | null {
  const authPath = join(resolveAgentDir(), "auth.json");
  if (!existsSync(authPath)) return null;
  try {
    const raw = JSON.parse(readFileSync(authPath, "utf-8")) as {
      anthropic?: { access?: unknown; expires?: unknown };
    };
    const anthropic = raw.anthropic;
    if (!anthropic || typeof anthropic.access !== "string" || !anthropic.access) return null;
    return {
      access: anthropic.access,
      expired: typeof anthropic.expires === "number" && anthropic.expires <= Date.now(),
    };
  } catch {
    return null;
  }
}

interface AnthropicOAuthCreds {
  type?: unknown;
  access?: unknown;
  refresh?: unknown;
  expires?: unknown;
}

interface CopilotOAuthCreds extends AnthropicOAuthCreds {
  enterpriseUrl?: unknown;
}

// pi's own ModelRegistry (ctx.modelRegistry), captured at session start. Used
// as the refresh path when the direct `@earendil-works/pi-ai/oauth` import is
// unavailable: the standalone pi binary (>= 0.84) bundles that subpath as an
// empty module, so refreshAnthropicToken/refreshGitHubCopilotToken are
// undefined at runtime there even though they type-check against node_modules.
// Also the source of Claude model capabilities for the sub provider — pi keeps
// its catalog fresher than the pinned pi-ai's static one, which lacks the very
// models this matters for.
let modelRegistryRef: {
  getApiKeyForProvider?: (provider: string) => Promise<string | undefined>;
  find?: (provider: string, modelId: string) => { compat?: unknown; thinkingLevelMap?: unknown; contextWindow?: number; maxTokens?: number } | undefined;
  getAll?: () => Array<{ provider?: string; id?: string }>;
} | null = null;

export function setModelRegistry(registry: unknown): void {
  modelRegistryRef = registry && typeof (registry as any).getApiKeyForProvider === "function" ? registry as any : null;
}

function readOAuthEntry<T extends AnthropicOAuthCreds>(authPath: string, provider: string): T | undefined {
  try {
    return (JSON.parse(readFileSync(authPath, "utf-8")) as Record<string, T | undefined>)[provider];
  } catch {
    return undefined;
  }
}

/**
 * Refresh `provider`'s OAuth credential through pi's registry, which refreshes
 * and persists to auth.json itself, then re-read the persisted entry. Returns
 * null when no registry is available or pi could not produce a fresh token.
 */
async function refreshViaModelRegistry<T extends AnthropicOAuthCreds>(authPath: string, provider: string): Promise<T | null> {
  const registry = modelRegistryRef;
  if (!registry?.getApiKeyForProvider) return null;
  const apiKey = await registry.getApiKeyForProvider(provider);
  if (!apiKey) return null;
  const entry = readOAuthEntry<T>(authPath, provider);
  if (!entry || typeof entry.access !== "string" || !entry.access) return null;
  if (typeof entry.expires === "number" && entry.expires <= Date.now()) return null;
  return entry;
}

export function readCopilotOAuthToken(): string | null {
  const authPath = join(resolveAgentDir(), "auth.json");
  if (!existsSync(authPath)) return null;
  try {
    const raw = JSON.parse(readFileSync(authPath, "utf-8")) as { "github-copilot"?: CopilotOAuthCreds };
    const copilot = raw["github-copilot"];
    if (!copilot || typeof copilot.access !== "string" || !copilot.access) return null;
    if (typeof copilot.expires === "number" && copilot.expires <= Date.now()) return null;
    return copilot.access;
  } catch {
    return null;
  }
}

/**
 * Read the OAuth access token pi persists for its built-in `openai-codex`
 * provider, which bills a personal ChatGPT Plus/Pro subscription. pi owns the
 * login and the refresh; this only establishes whether the tier has a
 * credential to route onto.
 */
export function readCodexOAuthToken(): string | null {
  const entry = readOAuthEntry<AnthropicOAuthCreds>(join(resolveAgentDir(), "auth.json"), CODEX_PROVIDER);
  if (!entry || typeof entry.access !== "string" || !entry.access) return null;
  if (typeof entry.expires === "number" && entry.expires <= Date.now()) return null;
  return entry.access;
}

/**
 * Whether a ChatGPT login exists at all, counting one whose access token has
 * expired but still carries a refresh token. The tier must stay enabled in
 * that state: disabling it routes the work elsewhere, so the request that
 * would have refreshed the token never goes out and the login never recovers.
 */
export function hasCodexCredential(): boolean {
  const entry = readOAuthEntry<AnthropicOAuthCreds>(join(resolveAgentDir(), "auth.json"), CODEX_PROVIDER);
  if (!entry || typeof entry.access !== "string" || !entry.access) return false;
  if (typeof entry.expires !== "number" || entry.expires > Date.now()) return true;
  return typeof entry.refresh === "string" && !!entry.refresh;
}

/**
 * Renew the ChatGPT credential through pi's own registry, which owns this
 * provider's refresh grant and persists the result to auth.json. Returns the
 * usable access token, or null when there is nothing to renew.
 */
export async function refreshCodexOAuthToken(): Promise<string | null> {
  const authPath = join(resolveAgentDir(), "auth.json");
  if (!existsSync(authPath)) return null;
  const entry = readOAuthEntry<AnthropicOAuthCreds>(authPath, CODEX_PROVIDER);
  if (!entry || typeof entry.access !== "string" || !entry.access) return null;

  const expires = typeof entry.expires === "number" ? entry.expires : 0;
  if (expires > Date.now() + 5 * 60_000) return entry.access;
  if (typeof entry.refresh !== "string" || !entry.refresh) return null;

  try {
    const refreshed = await refreshViaModelRegistry<AnthropicOAuthCreds>(authPath, CODEX_PROVIDER);
    if (refreshed) return refreshed.access as string;
  } catch (err: any) {
    getLogger().debug({ s: "flant", err: err?.message }, "codex oauth token refresh failed");
  }
  return null;
}

export async function refreshCopilotOAuthToken(): Promise<string | null> {
  const log = getLogger();
  const authPath = join(resolveAgentDir(), "auth.json");
  if (!existsSync(authPath)) return null;

  const copilot = readOAuthEntry<CopilotOAuthCreds>(authPath, "github-copilot");
  if (!copilot || typeof copilot.access !== "string" || !copilot.access) return null;

  const REFRESH_MARGIN_MS = 5 * 60_000;
  const expires = typeof copilot.expires === "number" ? copilot.expires : 0;
  if (expires > Date.now() + REFRESH_MARGIN_MS) return copilot.access;
  if (typeof copilot.refresh !== "string" || !copilot.refresh) return null;

  if (typeof oauth.refreshGitHubCopilotToken !== "function") {
    try {
      const entry = await refreshViaModelRegistry<CopilotOAuthCreds>(authPath, "github-copilot");
      if (entry) return entry.access as string;
      log.debug({ s: "flant" }, "copilot oauth token refresh unavailable");
    } catch (err: any) {
      log.debug({ s: "flant", err: err?.message }, "copilot oauth token refresh failed");
    }
    return null;
  }

  const enterpriseUrl = typeof copilot.enterpriseUrl === "string" ? copilot.enterpriseUrl : undefined;
  let refreshed: { refresh: string; access: string; expires: number; enterpriseUrl?: string };
  try {
    refreshed = await oauth.refreshGitHubCopilotToken!(copilot.refresh, enterpriseUrl);
  } catch (err: any) {
    log.debug({ s: "flant", err: err?.message }, "copilot oauth token refresh failed");
    return null;
  }

  try {
    const release = lockfile.lockSync(authPath, { stale: 10000 });
    try {
      let current: Record<string, unknown> = {};
      try {
        current = JSON.parse(readFileSync(authPath, "utf-8")) as Record<string, unknown>;
      } catch {}
      const existing = current["github-copilot"] && typeof current["github-copilot"] === "object"
        ? current["github-copilot"] as Record<string, unknown>
        : {};
      const existingExpires = typeof existing.expires === "number" ? existing.expires : 0;
      if (existingExpires > Date.now() + REFRESH_MARGIN_MS && typeof existing.access === "string" && existing.access) {
        return existing.access;
      }
      current["github-copilot"] = { ...existing, type: "oauth", ...refreshed };
      writeFileSync(authPath, JSON.stringify(current, null, 2) + "\n", "utf-8");
    } finally {
      release();
    }
  } catch (err: any) {
    log.debug({ s: "flant", err: err?.message }, "failed to persist copilot oauth token");
  }
  return refreshed.access;
}

/**
 * Ensure the persisted Claude OAuth access token is fresh, refreshing it via
 * the stored refresh token when it has expired (or is within its safety
 * margin). The refreshed credentials are written back to `auth.json` under the
 * `anthropic` provider id in pi's own `{ type: "oauth", ... }` format, so both
 * this extension and pi's built-in `anthropic` provider observe the new token.
 *
 * Unlike readClaudeOAuthToken, this is async (a refresh performs a network
 * call) and returns the valid access token, or null when no usable
 * credentials exist / a refresh fails. Async entry points call this before the
 * synchronous readClaudeOAuthToken so downstream reads see a fresh token.
 */
export async function refreshClaudeOAuthToken(): Promise<string | null> {
  const log = getLogger();
  const authPath = join(resolveAgentDir(), "auth.json");
  if (!existsSync(authPath)) return null;

  const anthropic = readOAuthEntry<AnthropicOAuthCreds>(authPath, "anthropic");
  if (!anthropic || typeof anthropic.access !== "string" || !anthropic.access) return null;

  // Refresh ahead of expiry so in-flight requests never race a dying token.
  const expires = typeof anthropic.expires === "number" ? anthropic.expires : 0;
  if (expires > Date.now() + CLAUDE_REFRESH_MARGIN_MS) return anthropic.access;

  // Expired (or expiring soon, or no expiry recorded): try to refresh.
  if (typeof anthropic.refresh !== "string" || !anthropic.refresh) {
    log.debug({ s: "flant" }, "claude oauth token expired and no refresh token available");
    return null;
  }

  if (typeof oauth.refreshAnthropicToken !== "function") {
    try {
      const entry = await refreshViaModelRegistry<AnthropicOAuthCreds>(authPath, "anthropic");
      if (entry) {
        log.debug({ s: "flant" }, "refreshed claude oauth token via pi registry");
        return entry.access as string;
      }
      log.debug({ s: "flant" }, "claude oauth token refresh unavailable");
    } catch (err: any) {
      log.debug({ s: "flant", err: err?.message }, "claude oauth token refresh failed");
    }
    return null;
  }

  let refreshed: { refresh: string; access: string; expires: number };
  try {
    refreshed = await oauth.refreshAnthropicToken!(anthropic.refresh);
  } catch (err: any) {
    log.debug({ s: "flant", err: err?.message }, "claude oauth token refresh failed");
    return null;
  }

  // A credential that could not be written is not usable: the grant consumed the
  // stored refresh token, so disk now holds something that cannot be refreshed
  // again, and every consumer reads the token from disk.
  const persisted = await persistClaudeCredentials(refreshed, { keepFresherExisting: true, consumedRefresh: anthropic.refresh });
  if (persisted !== refreshed.access) return persisted;

  log.debug({ s: "flant" }, "refreshed claude oauth token");
  return refreshed.access;
}

// Write refreshed credentials back under the `anthropic` provider id, using pi's
// { type: "oauth", ... } shape and the same file lock pi uses, so pi's built-in
// provider observes the rotation too. Returns the access token that ended up on
// disk, or null when it could not be written.
//
// Two things can be on disk by the time the lock is taken, because the token was
// minted before it: a credential another instance rotated to (keepFresherExisting
// keeps it), or a credential minted from a DIFFERENT refresh token than the one
// this rotation consumed (consumedRefresh) — meaning the other instance won the
// race and ours is the loser of a superseded chain. Keeping theirs in both cases
// is what stops two processes from revoking each other in a loop.
async function persistClaudeCredentials(
  refreshed: { refresh: string; access: string; expires: number },
  options: { keepFresherExisting?: boolean; consumedRefresh?: string } = {},
): Promise<string | null> {
  const authDir = resolveAgentDir();
  const authPath = join(authDir, "auth.json");
  try {
    if (!existsSync(authDir)) mkdirSync(authDir, { recursive: true });
    if (!existsSync(authPath)) writeFileSync(authPath, "{}\n", "utf-8");
    // Retried rather than failed-fast, which is why this takes the async lock:
    // the grant already consumed the previous refresh token, so losing the write
    // loses the only usable credential and forces a re-login. Mirrors the retry
    // policy of pi's own auth storage, whose lock this contends with.
    const release = await lockfile.lock(authPath, {
      stale: 10000,
      retries: { retries: 10, factor: 2, minTimeout: 100, maxTimeout: 10000, randomize: true },
    });
    try {
      let current: Record<string, unknown> = {};
      try {
        current = JSON.parse(readFileSync(authPath, "utf-8")) as Record<string, unknown>;
      } catch {
        current = {};
      }
      const existing = (current.anthropic && typeof current.anthropic === "object")
        ? current.anthropic as Record<string, unknown>
        : {};
      const existingExpires = typeof existing.expires === "number" ? existing.expires : 0;
      const existingAccess = typeof existing.access === "string" ? existing.access : "";
      if (existingAccess) {
        if (options.keepFresherExisting && existingExpires > Date.now() + CLAUDE_REFRESH_MARGIN_MS) {
          return existingAccess;
        }
        if (options.consumedRefresh && existing.refresh !== options.consumedRefresh) {
          getLogger().debug({ s: "flant" }, "another instance rotated the claude credential first; keeping its token");
          return existingAccess;
        }
      }
      current.anthropic = {
        ...existing,
        type: "oauth",
        access: refreshed.access,
        refresh: refreshed.refresh,
        expires: refreshed.expires,
      };
      writeFileSync(authPath, JSON.stringify(current, null, 2) + "\n", "utf-8");
    } finally {
      await release();
    }
  } catch (err: any) {
    getLogger().warn({ s: "flant", err: err?.message }, "failed to persist refreshed claude oauth token");
    return null;
  }
  return refreshed.access;
}

let forcedRefreshAt = 0;
let forcedRefreshInFlight: Promise<ForcedRefreshResult> | null = null;
// The credential this process last minted through a forced rotation. A request
// rejecting THAT token means rotating again is not the fix (the gateway key, the
// account, or the whole refresh chain is the problem), so the second attempt is
// refused instead of rotating on every turn or every probe interval — which
// would revoke the shared credential out from under every other client.
let lastForcedMint: string | null = null;

export type ForcedRefreshResult =
  /** A new credential was minted, or another instance's newer one adopted. */
  | { status: "rotated"; token: string }
  /** Another rotation happened moments ago; this one was suppressed. */
  | { status: "throttled" }
  /** No usable credential can be produced; the subscription is unusable. */
  | { status: "failed" };

/**
 * Rotate the Claude OAuth credential even though the persisted one has not
 * expired. This is the recovery path for a token the server REVOKED — another
 * client rotating the same credential invalidates ours while it stays
 * clock-valid, so every expiry-based check (including pi's own registry
 * refresh) keeps handing out a dead token until it finally expires.
 *
 * `rejectedToken` must be the token the failing request actually carried, not
 * whatever is on disk now: when the persisted one already differs, another
 * instance rotated in the meantime and its token is adopted rather than rotated
 * away — otherwise two processes revoke each other in a loop.
 */
export async function forceRefreshClaudeOAuthToken(rejectedToken?: string | null): Promise<ForcedRefreshResult> {
  if (forcedRefreshInFlight) return forcedRefreshInFlight;
  forcedRefreshInFlight = (async () => {
    const log = getLogger();
    const authPath = join(resolveAgentDir(), "auth.json");
    if (!existsSync(authPath)) return { status: "failed" };
    const anthropic = readOAuthEntry<AnthropicOAuthCreds>(authPath, "anthropic");
    if (!anthropic) return { status: "failed" };
    const persisted = typeof anthropic.access === "string" ? anthropic.access : "";
    // Checked before the cooldown: parallel workers all fail on the same token,
    // and every one after the first must adopt the fresh credential rather than
    // be told to wait for a rotation that already happened.
    if (rejectedToken && persisted && persisted !== rejectedToken) {
      log.debug({ s: "flant" }, "claude oauth token already rotated elsewhere; reusing the persisted one");
      return { status: "rotated", token: persisted };
    }
    if (rejectedToken && lastForcedMint && rejectedToken === lastForcedMint) {
      log.warn({ s: "flant" }, "a freshly minted claude credential was rejected too; not rotating again");
      return { status: "failed" };
    }
    if (Date.now() - forcedRefreshAt < FORCED_REFRESH_COOLDOWN_MS) return { status: "throttled" };
    if (typeof anthropic.refresh !== "string" || !anthropic.refresh) {
      log.debug({ s: "flant" }, "claude oauth credential rejected and no refresh token available");
      return { status: "failed" };
    }
    forcedRefreshAt = Date.now();
    let refreshed: { refresh: string; access: string; expires: number };
    try {
      refreshed = await requestClaudeTokenRefresh(anthropic.refresh);
    } catch (err: any) {
      log.warn({ s: "flant", err: err?.message }, "forced claude oauth token refresh failed");
      // The usual reason a grant fails is that another instance consumed this
      // single-use refresh token first — in which case its replacement is on
      // disk by now and is exactly what this caller needs.
      const adopted = readOAuthEntry<AnthropicOAuthCreds>(authPath, "anthropic")?.access;
      if (typeof adopted === "string" && adopted && adopted !== persisted) {
        log.debug({ s: "flant" }, "adopting the credential another instance minted after our grant failed");
        return { status: "rotated", token: adopted };
      }
      return { status: "failed" };
    }
    // A credential that could not be written is not usable: the provider is
    // rebound by re-reading auth.json, and pi's own provider reads the same
    // file, so returning an unpersisted token would register the rejected one.
    const stored = await persistClaudeCredentials(refreshed, { consumedRefresh: anthropic.refresh });
    if (!stored) return { status: "failed" };
    lastForcedMint = stored;
    log.info({ s: "flant" }, "force-refreshed the claude oauth token after a rejected credential");
    return { status: "rotated", token: stored };
  })();
  try {
    return await forcedRefreshInFlight;
  } finally {
    forcedRefreshInFlight = null;
  }
}

/**
 * Record that a subscription request demonstrably succeeded. The credential in
 * use works, so a later rejection is a NEW failure deserving its own rotation
 * rather than the "already tried that" refusal above.
 */
export function noteSubscriptionCredentialAccepted(): void {
  lastForcedMint = null;
}

// Mint a new Claude OAuth credential from a refresh token. Prefers pi-ai's own
// implementation and falls back to the same public endpoint/client it uses,
// because the standalone pi binary bundles `pi-ai/oauth` as an empty module —
// and pi's registry cannot stand in here, since it refuses to refresh a
// credential it still considers unexpired.
async function requestClaudeTokenRefresh(refreshToken: string): Promise<{ refresh: string; access: string; expires: number }> {
  if (typeof oauth.refreshAnthropicToken === "function") return oauth.refreshAnthropicToken(refreshToken);
  const res = await fetch(ANTHROPIC_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ grant_type: "refresh_token", client_id: ANTHROPIC_CLIENT_ID, refresh_token: refreshToken }),
    signal: AbortSignal.timeout(30000),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`Anthropic token refresh returned ${res.status}: ${body.slice(0, 200)}`);
  const data = JSON.parse(body) as { refresh_token: string; access_token: string; expires_in: number };
  return {
    refresh: data.refresh_token,
    access: data.access_token,
    expires: Date.now() + data.expires_in * 1000 - CLAUDE_REFRESH_MARGIN_MS,
  };
}

/** Resolve the gateway API key (LLM_API_KEY preferred, FLANT_API_KEY fallback). */
export function readGatewayApiKey(): string | null {
  return process.env.LLM_API_KEY ?? process.env.FLANT_API_KEY ?? null;
}

let piRef: ExtensionAPI | null = null;

/**
 * Inputs needed to (re)register the personal-subscription Claude providers.
 * Cached at the last registration so refreshSubProvider can rebuild them with a
 * freshly-read OAuth token without re-discovering models. Null when no route
 * of the subscription is registered.
 */
interface SubProviderContext {
  anthropicModels: string[];
  metadata: Record<string, OpenRouterModelData>;
  routes: { direct: boolean; gateway: boolean };
}
let subProviderContext: SubProviderContext | null = null;
/** The OAuth access token the subscription providers were last registered with. */
let lastSubToken: string | null = null;

export function setPI(pi: ExtensionAPI): void {
  piRef = pi;
}

export function unregisterFlantProviders(pi?: ExtensionAPI): void {
  // Cleared before the guard: otherwise the per-turn refreshSubProvider would
  // re-register the sub provider the next time the OAuth token rotates.
  subProviderContext = null;
  lastSubToken = null;
  const api = pi ?? piRef;
  if (!api) return;
  api.unregisterProvider("pp-flant-anthropic");
  api.unregisterProvider(LLM_API_PROVIDER);
  api.unregisterProvider(SUB_PROVIDER);
  api.unregisterProvider(DIRECT_SUB_PROVIDER);
}

function ensureSettingsDir(): void {
  if (!existsSync(SETTINGS_DIR)) {
    mkdirSync(SETTINGS_DIR, { recursive: true });
  }
}

function toNumber(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

export function loadLlmApiCache(): LlmApiCache {
  const empty: LlmApiCache = { lastUpdated: null, cachedFlantModels: null, cachedOpenRouterData: null, unmappedModels: null };
  if (!existsSync(SETTINGS_PATH)) return empty;
  try {
    const value = JSON.parse(readFileSync(SETTINGS_PATH, "utf-8")) as Record<string, unknown>;
    return {
      lastUpdated: typeof value.lastUpdated === "string" ? value.lastUpdated : null,
      cachedFlantModels: Array.isArray(value.cachedFlantModels)
        ? value.cachedFlantModels.filter((m): m is string => typeof m === "string")
        : null,
      cachedOpenRouterData: value.cachedOpenRouterData && typeof value.cachedOpenRouterData === "object"
        ? (value.cachedOpenRouterData as Record<string, OpenRouterModelData>)
        : null,
      unmappedModels: value.unmappedModels && typeof value.unmappedModels === "object"
        ? (value.unmappedModels as Record<string, string>)
        : null,
    };
  } catch {
    return empty;
  }
}

function saveLlmApiCache(cache: LlmApiCache): void {
  ensureSettingsDir();
  if (!existsSync(SETTINGS_PATH)) writeFileSync(SETTINGS_PATH, "{}\n", "utf-8");
  const release = lockfile.lockSync(SETTINGS_PATH, { stale: 10000 });
  try {
    const out: LlmApiCache = {
      lastUpdated: cache.lastUpdated,
      cachedFlantModels: cache.cachedFlantModels,
      cachedOpenRouterData: cache.cachedOpenRouterData,
      unmappedModels: cache.unmappedModels,
    };
    // Written through a temp file and renamed: a process killed mid-write would
    // otherwise leave truncated JSON, and an unreadable cache registers NO
    // gateway providers at extension load — early enough that the host cannot
    // restore the session's model and falls back to an unrelated one.
    const temp = `${SETTINGS_PATH}.${process.pid}.tmp`;
    try {
      writeFileSync(temp, JSON.stringify(out, null, 2) + "\n", "utf-8");
      renameSync(temp, SETTINGS_PATH);
    } catch (err) {
      try { unlinkSync(temp); } catch { /* the temp file may never have been created */ }
      throw err;
    }
  } finally {
    release();
  }
}

/** Effective provider settings: scoped config (cwd binds the project layer). */
export function loadRoutingSettings(cwd?: string): RoutingSettings {
  return readScopedRoutingSettings(cwd);
}

function toTitleCase(token: string): string {
  const lower = token.toLowerCase();
  if (lower === "gpt") return "GPT";
  if (lower === "o3") return "O3";
  if (lower === "qwen") return "Qwen";
  if (lower === "claude") return "Claude";
  if (lower === "api") return "API";
  if (lower === "ai") return "AI";
  if (!token.length) return token;
  return token.charAt(0).toUpperCase() + token.slice(1);
}

export function generateDisplayName(flantId: string): string {
  const parts = flantId.split("-").filter(Boolean);
  const out: string[] = [];
  let i = 0;
  while (i < parts.length) {
    const part = parts[i];
    if (/^\d+$/.test(part)) {
      const versionParts = [part];
      i += 1;
      while (i < parts.length && /^\d+$/.test(parts[i])) {
        versionParts.push(parts[i]);
        i += 1;
      }
      out.push(versionParts.join("."));
      continue;
    }
    out.push(toTitleCase(part));
    i += 1;
  }
  return out.join(" ");
}

function mapClaudeModelId(modelId: string): string {
  const rest = modelId.slice("claude-".length);
  const parts = rest.split("-").filter(Boolean);
  const firstNumber = parts.findIndex((p) => /^\d+$/.test(p));
  if (firstNumber === -1) return `anthropic/claude-${rest}`;
  const family = parts.slice(0, firstNumber).join("-");
  const version = parts.slice(firstNumber).join(".");
  return family.length > 0
    ? `anthropic/claude-${family}-${version}`
    : `anthropic/claude-${version}`;
}

function normalizeQwenRest(rest: string): string {
  let value = rest;
  if (value.startsWith("-")) value = value.slice(1);
  if (!value) return "default";
  return value;
}

function mapFlantToOpenRouterId(modelId: string): string | null {
  if (GEMINI_MAP[modelId]) return GEMINI_MAP[modelId];
  if (modelId.startsWith("claude-")) return mapClaudeModelId(modelId);
  if (modelId.startsWith("gpt-")) return `openai/${modelId}`;
  if (modelId.startsWith("deepseek-")) return `deepseek/deepseek-${modelId.slice("deepseek-".length)}`;
  if (modelId.startsWith("grok-")) return `x-ai/grok-${modelId.slice("grok-".length)}`;
  if (modelId.startsWith("minimax-")) return `minimax/minimax-${modelId.slice("minimax-".length)}`;
  if (modelId.startsWith("qwen")) return `qwen/qwen-${normalizeQwenRest(modelId.slice("qwen".length))}`;
  if (modelId.startsWith("o3-")) return `openai/o3-${modelId.slice("o3-".length)}`;
  if (modelId.startsWith("sonar-")) return `perplexity/sonar-${modelId.slice("sonar-".length)}`;
  return null;
}

/**
 * Out-of-band probe: is the personal Claude subscription limit cleared yet?
 * Sends a tiny, fully throwaway request (NOT part of the session, so it cannot
 * pollute conversation/context/cache) to the gateway's Anthropic endpoint using
 * the personal Claude OAuth token. Returns:
 *   "ok"          — 200: capacity is back (offer switch-back)
 *   "rate_limited" — 429: still limited (stay on non-sub, retry later)
 *   "error"       — credentials missing / network / other status (treat as not-back)
 *
 * The OAuth token is refreshed first so a failure is a genuine 429 and not an
 * expired-token false negative. `max_tokens: 1` + an explicit "just respond hi"
 * instruction keep output at ~1 token.
 */
// Derive the gateway probe model id (`sub/<bare-claude-id>`) from any stored
// form: `pp-flant-anthropic-sub/sub/<m>`, `pp-claude-sub/<m>`, `sub/<m>`, or a
// bare `<m>`. Exported for testing the derivation without a network call.
export function subProbeModelId(modelId: string): string {
  let bare = modelId;
  if (bare.startsWith(`${SUB_PROVIDER}/`)) bare = bare.slice(`${SUB_PROVIDER}/`.length);
  if (bare.startsWith(`${DIRECT_SUB_PROVIDER}/`)) bare = bare.slice(`${DIRECT_SUB_PROVIDER}/`.length);
  if (bare.startsWith(SUB_MODEL_PREFIX)) bare = bare.slice(SUB_MODEL_PREFIX.length);
  return `${SUB_MODEL_PREFIX}${bare}`;
}

/**
 * Where a probe of the subscription goes: through the gateway when that route
 * is registered, otherwise straight to Anthropic. Both answer for the same
 * account, so either says whether its quota is back.
 */
function probeTarget(probeModel: string): { url: string; model: string; headers: Record<string, string> } | null {
  const gatewayKey = readGatewayApiKey();
  const routes = subProviderContext?.routes;
  if (gatewayKey && (!routes || routes.gateway)) {
    return { url: "https://llm-api.flant.ru/v1/messages", model: probeModel, headers: { "x-litellm-api-key": `Bearer ${gatewayKey}` } };
  }
  if (!routes || routes.direct) {
    return { url: "https://api.anthropic.com/v1/messages", model: probeModel.slice(SUB_MODEL_PREFIX.length), headers: {} };
  }
  return null;
}

// Local matcher for the 400 "extra usage" body (kept here to avoid a circular
// import with rate-limit-fallback, which imports this module). Mirrors
// isExtraUsageError's phrasing.
function isExtraUsageMessage(text: string): boolean {
  return /extra usage|draw from[\s\S]{0,40}plan limits/i.test(text);
}

export async function probeSubscriptionCleared(
  modelId: string,
): Promise<"ok" | "rate_limited" | "error"> {
  const log = getLogger();
  await refreshClaudeOAuthToken();
  const probeModel = subProbeModelId(modelId);
  let { outcome, token } = await sendSubscriptionProbe(probeModel);
  // A 401 is a REVOKED credential, not a limit: without rotating it here the
  // probe returns "error" forever and the switch-back never fires — the session
  // stays on the fallback tier until the token happens to expire on its own.
  // The rotation goes through the shared recovery path so the provider is
  // rebound too, or a cleared probe would switch back onto a registration still
  // carrying the rejected token as its literal apiKey.
  if (outcome === "unauthenticated" && await recoverRejectedSubCredential(undefined, token) === "rotated") {
    ({ outcome } = await sendSubscriptionProbe(probeModel));
  }
  switch (outcome) {
    case "ok":
      log.debug({ s: "flant", model: probeModel }, "probe: capacity back");
      noteSubscriptionCredentialAccepted();
      return "ok";
    case "rate_limited":
      log.debug({ s: "flant", model: probeModel }, "probe: still rate limited");
      return "rate_limited";
    case "unauthenticated":
      log.warn({ s: "flant", model: probeModel }, "probe: credential rejected even after a forced refresh");
      return "error";
    default:
      return "error";
  }
}

type SubscriptionProbeOutcome = "ok" | "rate_limited" | "unauthenticated" | "error";

// One minimal subscription request, shaped exactly like a live one, classified
// by what came back. Callers decide what to do about each outcome. The token it
// sent is reported alongside, so a rejection names the credential that actually
// failed rather than whatever the file holds by the time the caller looks.
async function sendSubscriptionProbe(probeModel: string): Promise<{ outcome: SubscriptionProbeOutcome; token: string | null }> {
  const log = getLogger();
  const oauthToken = readClaudeOAuthToken();
  const target = probeTarget(probeModel);
  if (!oauthToken || !target) {
    log.debug({ s: "flant", hasOAuth: !!oauthToken, hasRoute: !!target }, "probe skipped: missing credentials");
    return { outcome: "error", token: oauthToken };
  }
  // Build a payload that matches a LIVE subscription request's billing shape:
  // it must carry the Claude Code identity system block (so injectBillingHeader
  // passes its gate) and the billing system[0] entry the transform prepends.
  // Without this the probe lands in the "extra usage" bucket, keeps getting the
  // 400, is classified rate_limited, and the switch-back timer re-arms forever.
  const probePayload: Record<string, unknown> = {
    model: target.model,
    max_tokens: 1,
    system: [{ type: "text", text: CC_IDENTITY }],
    messages: [{ role: "user", content: "just respond hi" }],
    // No `temperature`: the gateway rejects it as deprecated for some models
    // (a separate 400 source) — sending it would make the probe 400 forever.
  };
  injectBillingHeader(probePayload);
  try {
    const res = await fetch(target.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
        // Claude Code OAuth identity headers — the gateway requires these for
        // subscription (sub/) routing; without them it can reject the probe and
        // we would never detect that the limit cleared. Mirrors doctor.ts.
        "anthropic-beta": "claude-code-20250219,oauth-2025-04-20",
        // Full-form Claude Code user-agent (same as live sub requests via the
        // sub provider's model.headers) — a bare claude-cli/1.0.0 is bucketed
        // as un-spoofed "extra usage" traffic and the probe never recovers.
        "user-agent": buildUserAgent(),
        "x-app": "cli",
        Authorization: `Bearer ${oauthToken}`,
        ...target.headers,
      },
      body: JSON.stringify(probePayload),
      signal: AbortSignal.timeout(30000),
    });
    if (res.ok) return { outcome: "ok", token: oauthToken };
    if (res.status === 429) return { outcome: "rate_limited", token: oauthToken };
    if (res.status === 401 || res.status === 403) return { outcome: "unauthenticated", token: oauthToken };
    // A 400 "extra usage" means the subscription pool is still exhausted (the
    // same failure the fallback was triggered for) — treat it as still-limited so
    // the shared switch-back probe keeps waiting rather than declaring recovery.
    if (res.status === 400) {
      let bodyText = "";
      try { bodyText = await res.text(); } catch { /* ignore */ }
      if (isExtraUsageMessage(bodyText)) return { outcome: "rate_limited", token: oauthToken };
    }
    log.debug({ s: "flant", model: probeModel, status: res.status }, "probe: unexpected status");
    return { outcome: "error", token: oauthToken };
  } catch (err: any) {
    log.debug({ s: "flant", err: err?.message }, "probe failed");
    return { outcome: "error", token: oauthToken };
  }
}

/**
 * Establish whether the subscription credential currently works, rotating it
 * when it does not:
 *
 *   "ok"           — accepted as-is, or refused over quota rather than identity
 *   "rotated"      — was rejected, a fresh credential is now registered
 *   "throttled"    — was rejected, but a rotation just happened; retry later
 *   "failed"       — rejected and unrenewable; the subscription is unusable
 *   "inconclusive" — nothing could be established (network, unexpected status)
 *
 * Every decision to rotate is made from THIS probe, whose token identity is
 * exact. Callers that only learn "something returned 401" — a finished turn, a
 * worker that failed minutes ago — cannot say which credential was rejected,
 * and guessing is what makes two instances rotate each other's token away.
 *
 * A 401 the gateway raised over its OWN key, or over a disabled account, is
 * indistinguishable here from a revoked token, so it does trigger one rotation.
 * What bounds it is that the rotation refuses to run twice on a credential this
 * process just minted, so the shared token cannot be spun once per turn.
 */
export async function reviveSubscriptionCredential(
  modelId: string,
  pi?: ExtensionAPI,
): Promise<"ok" | "inconclusive" | ForcedRefreshResult["status"]> {
  const { outcome, token } = await sendSubscriptionProbe(subProbeModelId(modelId));
  if (outcome === "ok" || outcome === "rate_limited") {
    // The probe reads the token from disk, but the provider holds it as a
    // literal: when another instance rotated it, a probe that succeeds proves
    // only that the DISK credential works, and resuming without rebinding sends
    // the old one again — a 401 per turn, forever, each one "recovering" here.
    if (token && token !== lastSubToken) await refreshSubProvider(pi);
    // Quota, not identity: on a 429 the credential itself is fine, but it has
    // not been shown to be ACCEPTED, so the one-rotation guard stays armed.
    if (outcome === "ok") noteSubscriptionCredentialAccepted();
    return "ok";
  }
  if (outcome === "error") return "inconclusive";
  getLogger().warn({ s: "flant" }, "the subscription credential was rejected; rotating it");
  return recoverRejectedSubCredential(pi, token);
}

export async function discoverFlantModels(apiKey: string): Promise<string[]> {
  const res = await fetch("https://llm-api.flant.ru/v1/models", {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) {
    throw new Error(`Flant API returned ${res.status}`);
  }
  const payload = await res.json() as { data?: Array<{ id?: unknown }> };
  const models = (payload.data ?? [])
    .map((m) => (typeof m.id === "string" ? m.id : ""))
    .filter((id) => id.length > 0 && !id.startsWith("or/"));
  return [...new Set(models)];
}

export async function fetchOpenRouterMetadata(modelIds: string[]): Promise<Record<string, OpenRouterModelData>> {
  const mapping = new Map<string, string>();
  for (const modelId of modelIds) {
    // The gateway lists Claude only under `sub/<bare-id>`, while every consumer
    // (registerSubProvider, buildProviderModelConfig) looks metadata up by the
    // BARE id — so key the result bare, not as listed.
    const key = modelId.startsWith(SUB_MODEL_PREFIX) ? modelId.slice(SUB_MODEL_PREFIX.length) : modelId;
    const mapped = mapFlantToOpenRouterId(key);
    if (mapped) mapping.set(key, mapped);
  }
  if (mapping.size === 0) return {};

  const res = await fetch("https://openrouter.ai/api/v1/models", {
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) {
    throw new Error(`OpenRouter API returned ${res.status}`);
  }

  const payload = await res.json() as { data?: Array<Record<string, unknown>> };
  const modelMap = new Map<string, Record<string, unknown>>();
  for (const item of payload.data ?? []) {
    const id = typeof item.id === "string" ? item.id : "";
    if (id) modelMap.set(id, item);
  }

  const out: Record<string, OpenRouterModelData> = {};
  for (const [flantModelId, openRouterId] of mapping.entries()) {
    const model = modelMap.get(openRouterId);
    if (!model) continue;
    const pricing = model.pricing && typeof model.pricing === "object"
      ? model.pricing as Record<string, unknown>
      : {};
    const architecture = model.architecture && typeof model.architecture === "object"
      ? model.architecture as Record<string, unknown>
      : {};
    const topProvider = model.top_provider && typeof model.top_provider === "object"
      ? model.top_provider as Record<string, unknown>
      : {};
    out[flantModelId] = {
      name: typeof model.name === "string" ? model.name : generateDisplayName(flantModelId),
      context_length: toNumber(model.context_length, FALLBACK_CONTEXT_WINDOW),
      max_completion_tokens: toNumber(topProvider.max_completion_tokens, 32000),
      pricing: {
        prompt: toNumber(pricing.prompt, 0),
        completion: toNumber(pricing.completion, 0),
        cacheRead: toNumber(pricing.input_cache_read, 0),
        cacheWrite: toNumber(pricing.input_cache_write, 0),
      },
      modality: typeof architecture.modality === "string" ? architecture.modality : "text",
    };
  }
  return out;
}

/** Whether the Claude subscription is enabled and logged in. */
export function hasClaudeSubCredential(): boolean {
  return !!readStoredClaudeOAuthToken();
}

function claudeSubRoutes(settings: RoutingSettings): { direct: boolean; gateway: boolean } {
  const sub = settings.providers["claude-sub"];
  if (!sub.enabled) return { direct: false, gateway: false };
  return {
    direct: sub.route.includes("direct"),
    gateway: sub.route.includes("llm-api") && settings.providers["llm-api"].enabled && !!readGatewayApiKey(),
  };
}

/**
 * Whether anything is routed onto the subscription at all. When a family
 * override takes Claude elsewhere and no role pins a subscription model, its
 * providers stay unregistered and nothing refreshes or probes its credential.
 */
export function isClaudeSubInUse(settings: RoutingSettings, pinnedSpecs: string[] = []): boolean {
  if (!settings.providers["claude-sub"].enabled) return false;
  if (!settings.models.claude.override) return true;
  return pinnedSpecs.some((spec) => spec.startsWith(`${SUB_PROVIDER}/`) || spec.startsWith(`${DIRECT_SUB_PROVIDER}/`));
}

/**
 * The gateway is LiteLLM in front of OpenRouter, and neither pins a session to
 * one upstream by default: consecutive requests land on deployments holding
 * unrelated prompt-cache state, so a long session re-buys the tail of its own
 * prompt every turn. `x-session-id` is the header OpenRouter documents for
 * sticky routing and the shape LiteLLM's own session-affinity check reads.
 * Inert until the gateway forwards client headers, which costs nothing while
 * it does not. Not applied to the `sub/` provider, whose compat pi's Claude
 * catalog owns.
 */
const SESSION_AFFINITY_COMPAT = { sendSessionAffinityHeaders: true, sessionAffinityFormat: "openrouter" } as const;

/**
 * The window assumed for a model whose metadata declares none.
 *
 * It is a guess, and an unlucky one to be wrong about downwards: a model whose
 * real window is five times this gets a fold ceiling below the prompt's own
 * incompressible floor, and folding then takes the tool results the turn is
 * working from. So a model that ends up here says so once.
 */
const FALLBACK_CONTEXT_WINDOW = 200_000;

const fallbackWindowLogged = new Set<string>();

function noteFallbackWindow(modelId: string, declared: OpenRouterModelData | undefined, resolved: number): void {
  if (resolved !== FALLBACK_CONTEXT_WINDOW) return;
  if (toNumber(declared?.context_length, 0) === FALLBACK_CONTEXT_WINDOW) return;
  if (fallbackWindowLogged.has(modelId)) return;
  fallbackWindowLogged.add(modelId);
  getLogger().warn(
    { s: "flant", model: modelId, contextWindow: resolved },
    "neither the gateway metadata nor the model catalog declares a context window; the prompt will be sized against the fallback",
  );
}

function buildProviderModelConfig(
  flantModelId: string,
  metadata: Record<string, OpenRouterModelData>,
): ProviderModelConfig {
  const modelMeta = metadata[flantModelId];
  const modality = (modelMeta?.modality ?? "text").toLowerCase();
  return {
    id: flantModelId,
    name: modelMeta?.name ?? generateDisplayName(flantModelId),
    reasoning: true,
    input: modality.includes("image") ? ["text", "image"] : ["text"],
    cost: {
      input: toNumber(modelMeta?.pricing.prompt, 0) * 1_000_000,
      output: toNumber(modelMeta?.pricing.completion, 0) * 1_000_000,
      cacheRead: toNumber(modelMeta?.pricing.cacheRead, 0) * 1_000_000,
      cacheWrite: toNumber(modelMeta?.pricing.cacheWrite, 0) * 1_000_000,
    },
    contextWindow: toNumber(modelMeta?.context_length, FALLBACK_CONTEXT_WINDOW),
    maxTokens: toNumber(modelMeta?.max_completion_tokens, 32000),
  };
}

/**
 * Copy a Claude model's capability metadata from pi's own catalog entry for the
 * bare id onto its `sub/`-prefixed twin. Without this the sub provider carries
 * no `compat`, so pi-ai sends the LEGACY `thinking: {type: "enabled"}` form and
 * the gateway returns a thinking block whose text is empty; only the adaptive
 * form `forceAdaptiveThinking` selects yields readable summaries. The same gap
 * drops `thinkingLevelMap`, silently clamping xhigh/max down to high.
 *
 * `allowedFallbackModels` is deliberately dropped: pi-ai turns it into a
 * server-side `fallbacks` param naming a BARE claude id, which the gateway key
 * cannot access (it only sees `sub/*`) and which would fail the whole request.
 *
 * The window and output cap come from here too. Without them a model the
 * gateway's metadata does not cover falls back to a 200K window, and a 200K
 * window puts the fold ceiling at 150K: every request over that folds as hard
 * as it can, still does not fit, and rewrites the prompt's prefix for nothing.
 *
 * `supportsMidConvoEffort` is inherited again. It rides the
 * `mid-conversation-output-config-2026-07-01` and
 * `thinking-binding-controls-2026-08-01` betas, which the gateway used to strip
 * from `anthropic-beta` against a hardcoded dictionary — every turn on the
 * flagged models (claude-opus-5, claude-fable-5-1) then 400'd with `Extra inputs
 * are not permitted`. The gateway now forwards an unknown Anthropic beta as-is,
 * verified against both betas on both models.
 */
function applyClaudeModelCapabilities(config: ProviderModelConfig, bareModelId: string): ProviderModelConfig {
  const catalog = modelRegistryRef?.find?.("anthropic", bareModelId)
    ?? (typeof getModel === "function" ? getModel("anthropic" as never, bareModelId as never) : undefined);
  if (!catalog) return config;
  const { allowedFallbackModels: _droppedFallbacks, ...compat } = (catalog.compat ?? {}) as Record<string, unknown>;
  const out: ProviderModelConfig = { ...config };
  if (Object.keys(compat).length > 0) out.compat = compat as ProviderModelConfig["compat"];
  if (catalog.thinkingLevelMap) out.thinkingLevelMap = catalog.thinkingLevelMap as ProviderModelConfig["thinkingLevelMap"];
  if (typeof catalog.contextWindow === "number" && catalog.contextWindow > 0) out.contextWindow = catalog.contextWindow;
  if (typeof catalog.maxTokens === "number" && catalog.maxTokens > 0) out.maxTokens = catalog.maxTokens;
  return out;
}

export interface RegisterFlantOptions {
  /** Effective provider settings; defaults to the global-only read. */
  settings?: RoutingSettings;
  /** Role pins, so a pinned subscription model keeps the provider registered under a Claude override. */
  pinnedSpecs?: string[];
}

/**
 * Register the LLM API provider (every non-Claude model the gateway serves) and
 * the Claude subscription's routes. Which of these a role lands on is decided by
 * routing, not here: a provider without models or credentials is simply absent
 * from the catalog the resolver reads.
 */
export function registerFlantProviders(
  pi: ExtensionAPI,
  models: string[],
  metadata: Record<string, OpenRouterModelData>,
  options: RegisterFlantOptions = {},
): void {
  const log = getLogger();
  const settings = options.settings ?? loadRoutingSettings();
  const uniqueModels = [...new Set(models)];
  // The gateway serves Claude only through the personal subscription's `sub/`
  // groups; every claude id in the catalog (bare from legacy caches, or
  // `sub/`-prefixed from the live gateway) is a subscription candidate.
  const subCandidates = [...new Set(
    uniqueModels
      .filter((m) => m.startsWith("claude-") || m.startsWith(`${SUB_MODEL_PREFIX}claude-`))
      .map((m) => (m.startsWith(SUB_MODEL_PREFIX) ? m.slice(SUB_MODEL_PREFIX.length) : m)),
  )];
  const openaiModels = uniqueModels.filter((m) => !m.startsWith("claude-") && !m.startsWith(SUB_MODEL_PREFIX));

  unregisterFlantProviders(pi);

  const gatewayKey = readGatewayApiKey();
  if (settings.providers["llm-api"].enabled && gatewayKey) {
    pi.registerProvider(LLM_API_PROVIDER, {
      name: "LLM API",
      api: "openai-completions",
      baseUrl: "https://llm-api.flant.ru/v1",
      apiKey: gatewayKey,
      models: openaiModels.map((m) => {
        const config = buildProviderModelConfig(m, metadata);
        noteFallbackWindow(m, metadata[m], config.contextWindow ?? 0);
        return { ...config, compat: { ...SESSION_AFFINITY_COMPAT } };
      }),
    });
  }

  registerClaudeSub(pi, subCandidates, metadata, settings, options.pinnedSpecs ?? []);
  log.debug({ s: "flant", total: uniqueModels.length, sub: subCandidates.length, openai: openaiModels.length }, "registered gateway providers");
}

/**
 * Register the subscription's routes from cached gateway ids, or — with no
 * gateway at all — from pi's own Claude catalog, so the direct route works on a
 * machine that never had an LLM API key.
 */
export function registerClaudeSub(
  pi: ExtensionAPI,
  gatewayClaudeIds: string[],
  metadata: Record<string, OpenRouterModelData>,
  settings: RoutingSettings,
  pinnedSpecs: string[] = [],
): void {
  const routes = isClaudeSubInUse(settings, pinnedSpecs) ? claudeSubRoutes(settings) : { direct: false, gateway: false };
  if (!routes.direct && !routes.gateway) {
    subProviderContext = null;
    lastSubToken = null;
    pi.unregisterProvider(SUB_PROVIDER);
    pi.unregisterProvider(DIRECT_SUB_PROVIDER);
    return;
  }
  const anthropicModels = gatewayClaudeIds.length > 0 ? gatewayClaudeIds : nativeClaudeIds();
  subProviderContext = { anthropicModels, metadata, routes };
  registerSubProvider(pi, anthropicModels, metadata, routes);
}

function nativeClaudeIds(): string[] {
  const all = modelRegistryRef?.getAll?.() ?? [];
  const ids = all.filter((m) => m?.provider === "anthropic" && typeof m.id === "string").map((m) => m.id as string);
  if (ids.length > 0) return [...new Set(ids)];
  try {
    return (getModels("anthropic" as never) as Array<{ id: string }>).map((m) => m.id);
  } catch {
    return [];
  }
}

/**
 * Register (or re-register) the subscription's providers with the OAuth access
 * token currently persisted in auth.json: the gateway route (model ids carry the
 * `sub/` prefix the gateway expects) and the direct route to Anthropic.
 *
 * Both take the token as a literal `apiKey`, so it is a snapshot for the life of
 * the registration. The token expires within hours, so refreshSubProvider must
 * run periodically to rebuild them; otherwise long sessions send a stale token.
 *
 * The direct route is registered by pi-pi rather than left to pi's own
 * `anthropic` provider because pi sends a bare `claude-cli/<its version>` agent,
 * and the subscription bills against the version the billing header signs.
 */
function registerSubProvider(
  pi: ExtensionAPI,
  anthropicModels: string[],
  metadata: Record<string, OpenRouterModelData>,
  routes: { direct: boolean; gateway: boolean },
): void {
  const log = getLogger();
  const stored = readStoredClaudeOAuthToken();
  const gatewayKey = readGatewayApiKey();
  if (!stored) {
    log.debug({ s: "flant" }, "Claude subscription enabled but not logged in; skipping its providers");
    pi.unregisterProvider(SUB_PROVIDER);
    pi.unregisterProvider(DIRECT_SUB_PROVIDER);
    lastSubToken = null;
    return;
  }
  const oauthToken = stored.access;
  if (stored.expired) {
    log.debug({ s: "flant" }, "registering the subscription with an expired token; a refresh re-registers it before the first request");
  }
  const claudeModels = (prefix: string) => anthropicModels.map((m) => {
    const cfg = applyClaudeModelCapabilities(buildProviderModelConfig(m, metadata), m);
    noteFallbackWindow(`${prefix}${m}`, metadata[m], cfg.contextWindow ?? 0);
    return { ...cfg, id: `${prefix}${m}` };
  });
  if (routes.gateway && gatewayKey) {
    pi.registerProvider(SUB_PROVIDER, {
      name: "Claude subscription (via LLM API)",
      api: "anthropic-messages",
      baseUrl: "https://llm-api.flant.ru",
      // The OAuth token (sk-ant-oat...) triggers pi-ai's Claude Code identity
      // headers and is forwarded as `Authorization: Bearer ...`.
      apiKey: oauthToken,
      // Gateway key travels in a side header so it does not clobber the OAuth
      // auth. The full-form Claude Code user-agent overrides pi-ai's bare one:
      // mergeHeaders applies these AFTER the default, and plan billing expects
      // this form, at the version the billing header's cc_version carries.
      headers: { "x-litellm-api-key": `Bearer ${gatewayKey}`, "user-agent": buildUserAgent() },
      models: claudeModels(SUB_MODEL_PREFIX),
    });
  } else {
    pi.unregisterProvider(SUB_PROVIDER);
  }
  if (routes.direct) {
    pi.registerProvider(DIRECT_SUB_PROVIDER, {
      name: "Claude subscription (direct)",
      api: "anthropic-messages",
      baseUrl: "https://api.anthropic.com",
      apiKey: oauthToken,
      headers: { "user-agent": buildUserAgent() },
      models: claudeModels(""),
    });
  } else {
    pi.unregisterProvider(DIRECT_SUB_PROVIDER);
  }
  lastSubToken = oauthToken;
}

/**
 * Ensure the subscription's providers are registered with a non-expired OAuth
 * token. Refreshes the token (persisting it to auth.json when needed) and, when
 * it changed since the last registration, re-registers them so subsequent
 * calls pick up the fresh token.
 *
 * Called on each turn for the root session. No-op while nothing routes onto the
 * subscription. Cheap when the token is unchanged (a token read + compare).
 */
export async function refreshSubProvider(pi?: ExtensionAPI): Promise<void> {
  const ctx = subProviderContext;
  if (!ctx) return;
  const api = pi ?? piRef;
  if (!api) return;

  await refreshClaudeOAuthToken();
  const token = readClaudeOAuthToken();
  const log = getLogger();
  if (!token) {
    // The registration still carries the previous token as a literal apiKey, so
    // leaving it in place turns every Claude request into a 401 instead of
    // letting resolution move on. The cached context stays, so a later refresh
    // that succeeds re-registers the providers.
    api.unregisterProvider(SUB_PROVIDER);
    api.unregisterProvider(DIRECT_SUB_PROVIDER);
    lastSubToken = null;
    log.debug({ s: "flant" }, "subscription oauth token unavailable; unregistered its providers");
    return;
  }
  if (token === lastSubToken) return;

  registerSubProvider(api, ctx.anthropicModels, ctx.metadata, ctx.routes);
  log.debug({ s: "flant" }, "re-registered the subscription with a refreshed oauth token");
}

/**
 * Recover from a subscription request rejected as unauthenticated. Rotates the
 * OAuth credential past its unexpired-looking state and rebinds the providers
 * to the new token. Returns false when no usable credential could be minted —
 * the caller must then route away from the subscription, because the
 * registration keeps failing every request until the user re-logs in.
 *
 * `rejectedToken` is the credential the failed request carried; it defaults to
 * the one the providers are registered with, NOT to whatever is on disk now,
 * which may already be another instance's replacement.
 */
export async function recoverRejectedSubCredential(
  pi?: ExtensionAPI,
  rejectedToken?: string | null,
): Promise<ForcedRefreshResult["status"]> {
  const rejected = rejectedToken ?? lastSubToken ?? readClaudeOAuthToken();
  const result = await forceRefreshClaudeOAuthToken(rejected);
  if (result.status !== "rotated") return result.status;
  const ctx = subProviderContext;
  const api = pi ?? piRef;
  if (ctx && api && result.token !== lastSubToken) {
    registerSubProvider(api, ctx.anthropicModels, ctx.metadata, ctx.routes);
    getLogger().info({ s: "flant" }, "rebound the subscription after a rejected credential");
  }
  return "rotated";
}

// Bare gateway id → the OpenRouter id a metadata fetch would look up. Only ids
// a fetch already tried and failed to resolve belong here; pairing each with the
// id that was tried lets a later mapping change retry it.
function collectUnmappedModels(models: string[], metadata: Record<string, OpenRouterModelData>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const modelId of models) {
    const bare = modelId.startsWith(SUB_MODEL_PREFIX) ? modelId.slice(SUB_MODEL_PREFIX.length) : modelId;
    const mapped = mapFlantToOpenRouterId(bare);
    if (mapped && !metadata[bare]) out[bare] = mapped;
  }
  return out;
}

function isCacheValid(cache: LlmApiCache, ttlDays: number): boolean {
  if (!cache.lastUpdated || !cache.cachedFlantModels || !cache.cachedOpenRouterData) return false;
  // An empty metadata map carries no context window and no pricing, so it is
  // never worth serving from cache — including caches an earlier build stamped.
  if (Object.keys(cache.cachedOpenRouterData).length === 0) return false;
  // A cache an earlier build stamped can be missing a whole family whose ids it
  // could not yet map, which leaves those models on the fallback window for the
  // rest of the TTL. Any mappable model without an entry means refetch, unless
  // the last fetch already established that OpenRouter has nothing under that id.
  const metadata = cache.cachedOpenRouterData;
  const unmapped = cache.unmappedModels ?? {};
  for (const modelId of cache.cachedFlantModels) {
    const bare = modelId.startsWith(SUB_MODEL_PREFIX) ? modelId.slice(SUB_MODEL_PREFIX.length) : modelId;
    const mapped = mapFlantToOpenRouterId(bare);
    if (mapped && !metadata[bare] && unmapped[bare] !== mapped) return false;
  }
  const updatedAt = new Date(cache.lastUpdated).getTime();
  if (!Number.isFinite(updatedAt)) return false;
  const ttlMs = Math.max(1, ttlDays) * 24 * 60 * 60 * 1000;
  return Date.now() - updatedAt < ttlMs;
}

export interface UpdateFlantOptions {
  /**
   * Bypass the TTL cache and re-fetch the model list from the gateway even when
   * the cache is still fresh. Set by the explicit "Update now" action so it does
   * what its label promises; auto/startup callers omit it and stay cache-bound.
   */
  force?: boolean;
  /** Project dir for binding project-scoped settings; omit for global-only. */
  cwd?: string;
  pinnedSpecs?: string[];
}

/** Whether the gateway catalog has anything to offer: the provider is on and its key is set. */
function gatewayWanted(settings: RoutingSettings): boolean {
  return !!readGatewayApiKey() && (settings.providers["llm-api"].enabled || claudeSubRoutes(settings).gateway);
}

export async function updateFlantInfra(
  pi: ExtensionAPI,
  options: UpdateFlantOptions = {},
): Promise<{ ok: boolean; error?: string; models?: string[] }> {
  setPI(pi);
  const settings = loadRoutingSettings(options.cwd);
  const cache = loadLlmApiCache();

  // Refresh the personal-subscription Claude OAuth token before (re)registering
  // providers so the sub provider is built with a valid, non-expired token.
  if (settings.providers["claude-sub"].enabled) await refreshClaudeOAuthToken();

  if (!gatewayWanted(settings)) {
    registerFlantProviders(pi, [], {}, { settings, pinnedSpecs: options.pinnedSpecs });
    return readGatewayApiKey() ? { ok: true, models: [] } : { ok: false, error: "LLM_API_KEY (or FLANT_API_KEY) is not set" };
  }

  const cacheOk = !options.force && isCacheValid(cache, settings.providers["llm-api"].cacheTTLDays);
  let models = cacheOk ? cache.cachedFlantModels : null;
  let metadata = cacheOk ? cache.cachedOpenRouterData : null;
  let refreshed = false;

  if (!models || !metadata) {
    const apiKey = readGatewayApiKey()!;
    try {
      models = await discoverFlantModels(apiKey);
      let metadataFetched = true;
      try {
        metadata = await fetchOpenRouterMetadata(models);
      } catch {
        metadataFetched = false;
        metadata = cache.cachedOpenRouterData ?? {};
      }
      cache.cachedFlantModels = models;
      cache.cachedOpenRouterData = metadata;
      // Only a fetch that actually reached OpenRouter can establish that a
      // model has no entry there; recording it after a failed one would
      // suppress the retry that fills in the models still missing metadata.
      if (metadataFetched) cache.unmappedModels = collectUnmappedModels(models, metadata);
      // Serving empty metadata pins every model to the fallback context window
      // and zero cost, so it must never look cache-valid: clear the timestamp
      // outright rather than merely declining to refresh it — a forced update
      // inside the TTL would otherwise keep the previous one alive. A fetch
      // that succeeds but matches nothing is just as empty as a failed one.
      cache.lastUpdated = Object.keys(metadata).length > 0 ? new Date().toISOString() : null;
      refreshed = true;
      // A cache that cannot be written still served this session; the next
      // start just fetches again.
      try { saveLlmApiCache(cache); } catch (err: any) {
        getLogger().warn({ s: "flant", err: err?.message }, "could not write the LLM API model cache");
      }
    } catch (err: any) {
      if (cache.cachedFlantModels && cache.cachedOpenRouterData) {
        models = cache.cachedFlantModels;
        metadata = cache.cachedOpenRouterData;
      } else {
        return { ok: false, error: err?.message ?? "Failed to update the LLM API model list" };
      }
    }
  }

  try {
    registerFlantProviders(pi, models, metadata, { settings, pinnedSpecs: options.pinnedSpecs });
    // Backfill a timestamp for a cache that predates stamping — but never for an
    // empty metadata map, which is exactly the state the stamp must not bless.
    if (!refreshed && cache.cachedFlantModels && !cache.lastUpdated && Object.keys(cache.cachedOpenRouterData ?? {}).length > 0) {
      cache.lastUpdated = new Date().toISOString();
      saveLlmApiCache(cache);
    }
    return { ok: true, models };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? "Failed to register the LLM API providers" };
  }
}

/** Whether Copilot is enabled and has environment or /login credentials. */
export function isCopilotActive(settings: RoutingSettings): boolean {
  return settings.providers.copilot.enabled && !!(process.env.COPILOT_GITHUB_TOKEN || readCopilotOAuthToken());
}

/** Whether the ChatGPT subscription is enabled and logged in. */
export function isCodexActive(settings: RoutingSettings): boolean {
  return settings.providers.codex.enabled && hasCodexCredential();
}

/**
 * Register providers from the cache only, without touching the network. Runs at
 * extension load (global-only settings, before any project is known) and in
 * every subagent session, which must see the same providers as its parent.
 */
export function initFlantSync(pi: ExtensionAPI, cwd?: string, pinnedSpecs: string[] = []): void {
  setPI(pi);
  const settings = loadRoutingSettings(cwd);
  const cache = loadLlmApiCache();
  const usable = gatewayWanted(settings) && cache.cachedFlantModels && cache.cachedOpenRouterData;
  registerFlantProviders(pi, usable ? cache.cachedFlantModels! : [], usable ? cache.cachedOpenRouterData! : {}, { settings, pinnedSpecs });
}

// `cwd` is the root session's project dir (known at session_start); passing it
// lets project-scoped settings bind. Omit for the global-only read.
export async function initFlantOnStartup(pi: ExtensionAPI, cwd?: string, pinnedSpecs: string[] = []): Promise<void> {
  setPI(pi);
  const settings = loadRoutingSettings(cwd);
  if (settings.providers.copilot.enabled && !process.env.COPILOT_GITHUB_TOKEN) await refreshCopilotOAuthToken();
  if (settings.providers.codex.enabled) await refreshCodexOAuthToken();
  const cache = loadLlmApiCache();
  if (!settings.providers["llm-api"].autoUpdate && cache.cachedFlantModels && cache.cachedOpenRouterData) {
    // autoUpdate=false means "do not REFRESH the cache", not "stay unregistered".
    if (settings.providers["claude-sub"].enabled) await refreshClaudeOAuthToken();
    const usable = gatewayWanted(settings);
    registerFlantProviders(pi, usable ? cache.cachedFlantModels : [], usable ? cache.cachedOpenRouterData : {}, { settings, pinnedSpecs });
    return;
  }
  await updateFlantInfra(pi, { cwd, pinnedSpecs });
}
