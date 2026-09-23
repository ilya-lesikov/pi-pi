import { execFileSync } from "child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { GLOBAL_CONFIG_PATH, mergeConfigLayers, readRawConfig, type NormalizedPiPiConfig } from "./config.js";
import { isCopilotTierActive, loadFlantSettings, readClaudeOAuthToken, readGatewayApiKey, resolveAgentDir } from "./flant-infra.js";
import { getAllAliases, resolveModel } from "./model-registry.js";
import { provisionDir } from "./provision/install.js";
import { provisionResults } from "./provision/session.js";
import { listLayeredSkills } from "./skills-manifest.js";
import { readProviderRetry } from "./provider-retry.js";
import type { Orchestrator } from "./orchestrator.js";

type Severity = "pass" | "warning" | "failure";

function statusSymbol(severity: Severity): string {
  if (severity === "pass") return "✓";
  if (severity === "warning") return "⚠";
  return "✗";
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// pi-pi copies declared in pi's own settings that are NOT the running one. A
// worker session builds its own resource loader, so it discovers these even when
// the root session was launched with --no-extensions -e: the worker then runs
// different pi-pi code than the session that spawned it, and the mismatch only
// surfaces as unexplained worker-only failures.
function foreignPiPiPackages(): string[] {
  const agentDir = resolveAgentDir();
  let packages: unknown;
  try {
    packages = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf-8"))?.packages;
  } catch {
    return [];
  }
  if (!Array.isArray(packages)) return [];
  const running = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
  // A package entry is either a bare source string or { source, ... }; remote
  // sources carry a scheme prefix, and a local one may be ~-relative.
  const sources = packages.flatMap((entry: any) => {
    const source = typeof entry === "string" ? entry : typeof entry?.source === "string" ? entry.source : undefined;
    if (!source || /^(npm|git|github|https?|ssh):/.test(source.trim())) return [];
    // pi expands exactly "~" and "~/…"; anything else starting with a tilde is
    // an ordinary relative path (resolved against the agent dir, as pi does).
    const trimmed = source.trim();
    const expanded = trimmed === "~" ? homedir() : trimmed.startsWith("~/") ? join(homedir(), trimmed.slice(2)) : trimmed;
    return [resolve(agentDir, expanded)];
  });
  return [...new Set(sources)].filter((path) => path !== running && existsSync(join(path, "extensions", "orchestrator")));
}

function which(bin: string): string | null {
  try {
    const whichCmd = process.platform === "win32" ? "where" : "which";
    const out = execFileSync(whichCmd, [bin], { encoding: "utf-8", stdio: "pipe" });
    return out.split("\n").map((line) => line.trim()).find((line) => line.length > 0) || null;
  } catch {
    return null;
  }
}

/** The binary a configured command line would actually run. */
function commandBinary(command: string): string | null {
  const tokens = command.trim().split(/\s+/).filter(Boolean);
  let index = 0;
  while (index < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index] ?? "")) index += 1;
  return tokens[index] ?? null;
}

function timedFetch(url: string, options: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timer));
}

function listAvailableSpecs(ctx: any): Set<string> {
  const available = ctx?.modelRegistry?.getAvailable?.();
  if (!Array.isArray(available)) return new Set();
  return new Set(
    available.flatMap((model: any) =>
      typeof model?.provider === "string" && typeof model?.id === "string" ? [`${model.provider.trim()}/${model.id.trim()}`] : []),
  );
}

export interface DoctorOptions {
  /** Reach the network to time each dependency. Off makes the run offline-safe. */
  probes?: boolean;
  /** Spawn each detected language server to prove it runs, not merely resolves. */
  probeServers?: boolean;
}

export async function runDoctor(orchestrator: Orchestrator, ctx: any, options: DoctorOptions = {}): Promise<void> {
  const { probes = true, probeServers = true } = options;
  const lines: string[] = ["Doctor Results"];
  let pass = 0;
  let warn = 0;
  let fail = 0;
  const add = (severity: Severity, text: string) => {
    if (severity === "pass") pass += 1;
    else if (severity === "warning") warn += 1;
    else fail += 1;
    lines.push(`  ${statusSymbol(severity)} ${text}`);
  };
  const detail = (text: string) => lines.push(`      ${text}`);
  const category = (name: string) => lines.push("", name);
  // A throwing check must not abort the run: the doctor is most needed exactly
  // when something is broken enough to throw.
  const guard = async (label: string, run: () => void | Promise<void>) => {
    try {
      await run();
    } catch (error) {
      add("failure", `${label}: ${message(error)}`);
    }
  };

  const config: NormalizedPiPiConfig = orchestrator.config;

  category("Config");
  await guard("Config check failed", () => {
    for (const [label, path] of [["global", GLOBAL_CONFIG_PATH], ["project", join(orchestrator.cwd, ".pp", "config.json")]] as const) {
      if (!existsSync(path)) {
        add("pass", `${label} config: none (defaults apply)`);
        continue;
      }
      try {
        readRawConfig(path);
        add("pass", `${label} config parses: ${path}`);
      } catch (error) {
        add("failure", `${label} config is unreadable (${path}): ${message(error)}`);
      }
    }
    mergeConfigLayers(readRawConfig(GLOBAL_CONFIG_PATH), readRawConfig(join(orchestrator.cwd, ".pp", "config.json")));
    add("pass", "Global and project config merge cleanly");
  });
  if (orchestrator.configError) add("failure", `Startup config error: ${orchestrator.configError}`);
  if (orchestrator.duplicateExtensionError) add("failure", "Duplicate extension copies detected (see startup notification)");

  category("Models");
  const availableSpecs = listAvailableSpecs(ctx);
  if (availableSpecs.size === 0) {
    add("warning", "Model registry unavailable — cannot verify agent model routing");
  } else {
    add("pass", `${availableSpecs.size} models available, ${Object.keys(getAllAliases()).length} aliases registered`);
    const roles: Array<{ label: string; model: string }> = [
      { label: "agents.main", model: config.agents.main.model },
      { label: "agents.subagents.simple.explore", model: config.agents.subagents.simple.explore.model },
      { label: "agents.subagents.simple.librarian", model: config.agents.subagents.simple.librarian.model },
      { label: "agents.subagents.simple.task", model: config.agents.subagents.simple.task.model },
    ];
    for (const pool of ["advisors", "reviewers", "deepDebuggers"] as const) {
      config.agents.subagents.pools[pool].forEach((entry, i) => {
        if (entry.enabled !== false) roles.push({ label: `pools.${pool}[${i}]`, model: entry.model });
      });
    }
    for (const role of roles) {
      const resolved = resolveModel(role.model);
      if (availableSpecs.has(resolved)) add("pass", `${role.label}: ${role.model} → ${resolved}`);
      else add("warning", `${role.label}: ${role.model} → ${resolved} is not in the available model list`);
    }
    for (const pool of ["advisors", "reviewers", "deepDebuggers"] as const) {
      const enabled = config.agents.subagents.pools[pool].filter((entry) => entry.enabled !== false).length;
      add(enabled > 0 ? "pass" : "warning", `pools.${pool}: ${enabled} of ${config.agents.subagents.pools[pool].length} enabled`);
    }
  }

  category("Extensions");
  const running = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
  add("pass", `Running pi-pi: ${running}`);
  try {
    const manifest = JSON.parse(readFileSync(join(running, "package.json"), "utf-8"));
    add("pass", `Version ${manifest.version ?? "unknown"}`);
    for (const entry of manifest.pi?.extensions ?? []) {
      const path = join(running, String(entry).replace(/^\.\//, ""));
      add(existsSync(path) || existsSync(`${path}.ts`) ? "pass" : "failure", `Declared extension: ${entry}`);
    }
  } catch (error) {
    add("failure", `Package manifest unreadable: ${message(error)}`);
  }
  // Extensions couple to each other through globalThis handles rather than
  // imports, so a missing one is invisible to types and to the type checker.
  const handles: Array<[string, string]> = [
    ["pi-subagents worker manager", "pi-subagents:manager"],
    ["pi-subagents fleet menu", "pi-subagents:menu"],
    ["pi-tasks store", "pi-tasks:store"],
    ["pi-lsp API", "pi-lsp:api"],
    ["CBM daemon", "pi-pi:cbm-daemon"],
    ["usage tracker", "pi-pi:usage-tracker"],
    ["root session source", "pi-pi:root-session-source"],
  ];
  for (const [label, key] of handles) {
    const present = (globalThis as any)[Symbol.for(key)] != null;
    add(present ? "pass" : "warning", `${label}: ${present ? "registered" : "not registered"} (${key})`);
  }
  for (const other of foreignPiPiPackages()) {
    add("warning", `Settings declare another pi-pi copy at ${other} — workers load that one, not this checkout`);
  }

  category("Tools");
  for (const [bin, why] of [["git", "repository work"], ["gh", "GitHub operations"], ["rg", "search"], ["codebase-memory-mcp", "code graph"], ["sg", "AST search"], ["node", "npm-based servers"]] as const) {
    const path = which(bin);
    add(path ? "pass" : bin === "git" ? "failure" : "warning", `${bin} (${why}): ${path ?? "not found"}`);
  }
  const daemon = (globalThis as any)[Symbol.for("pi-pi:cbm-daemon")] as { proc?: unknown } | null | undefined;
  if (which("codebase-memory-mcp")) {
    add(daemon && daemon.proc != null ? "pass" : "warning", `CBM daemon: ${daemon && daemon.proc != null ? "running" : "not started"}`);
  }

  category("Provisioning");
  add("pass", `Install directory: ${provisionDir()}`);
  const provisioned = provisionResults();
  if (provisioned.length === 0) {
    add("warning", "Nothing provisioned yet this session");
  }
  for (const outcome of provisioned) {
    if (outcome.status === "present") add("pass", `${outcome.binary}: already on PATH (${outcome.path})`);
    else if (outcome.status === "installed") {
      add("pass", `${outcome.binary}: installed ${outcome.version} — verification: ${outcome.verification}`);
      // Stated per tool rather than implied: only some publishers ship a digest.
      if (outcome.verification === "none") detail("no digest is published for this asset; transport integrity only");
    } else if (outcome.status === "unavailable") add("warning", `${outcome.binary}: unavailable — ${outcome.reason}`);
    else add("failure", `${outcome.binary}: install failed — ${outcome.reason}`);
  }

  category("LSP");
  await guard("LSP check failed", async () => {
    const api = (globalThis as any)[Symbol.for("pi-lsp:api")] as { describe?: (cwd: string, probe?: boolean) => Promise<any> } | undefined;
    if (!api?.describe) {
      add("warning", "LSP API not available — cannot report server state");
      return;
    }
    const state = await api.describe(orchestrator.cwd, probeServers);
    if (state.globalDisabled) {
      add("warning", "All LSP servers are disabled by config");
      return;
    }
    if (state.servers.length === 0) add("warning", "No language server detected for this machine");
    for (const server of state.servers) {
      if (server.probe === "failed") {
        add("failure", `${server.name}: ${server.command} resolves but does not run`);
        detail(`path: ${server.resolvedPath ?? "unknown"}`);
        if (server.error) detail(`error: ${server.error}`);
        // Where a shim reports why it cannot run, and the only place it does.
        for (const line of server.stderr ?? []) detail(`stderr: ${line}`);
        continue;
      }
      add("pass", `${server.name}: ${server.running ? "running" : "starts"} — handles ${server.extensions.join(", ")}`);
      detail(`path: ${server.resolvedPath ?? "unknown"}`);
    }
    for (const absent of state.missing) {
      add("warning", `${absent.name}: no server for ${absent.extensions.join(", ")} — wants ${absent.command.join(" ")}`);
    }
    for (const error of state.errors ?? []) add("failure", `LSP config error: ${error}`);
  });

  category("Skills");
  await guard("Skill discovery failed", () => {
    const skills = listLayeredSkills(orchestrator.cwd, undefined);
    add(skills.length > 0 ? "pass" : "warning", `${skills.length} skills discovered`);
    for (const skill of skills) {
      const shadowed = skill.shadows.length > 0 ? ` (shadows ${skill.shadows.join(", ")})` : "";
      detail(`${skill.name} [${skill.layer}]${shadowed}`);
    }
  });

  category("Commands");
  const afterEdit = Object.entries(config.commands.afterEdit);
  if (afterEdit.length === 0) add("pass", "No afterEdit commands configured");
  for (const [name, command] of afterEdit) {
    if (command.enabled === false) {
      add("pass", `afterEdit.${name}: disabled`);
      continue;
    }
    const bin = commandBinary(command.run);
    if (!bin) {
      add("failure", `afterEdit.${name}: no binary in "${command.run}"`);
      continue;
    }
    const path = bin.startsWith("/") || bin.startsWith("./") ? (existsSync(resolve(orchestrator.cwd, bin)) ? bin : null) : which(bin);
    add(path ? "pass" : "failure", `afterEdit.${name}: ${bin} ${path ? `found at ${path}` : "not found"}`);
  }

  category("Flant");
  // Guarded: this rereads the scoped config, and a malformed one throws — which
  // would abort the run before the summary, exactly when the doctor is needed.
  await guard("Flant settings unreadable", async () => {
    const flant = loadFlantSettings(orchestrator.cwd);
    if (!flant.enabled) {
      add("pass", "Flant disabled");
      return;
    }
    const key = readGatewayApiKey();
    if (key) add("pass", "Gateway API key present");
    else add("failure", "Flant enabled but no gateway key (set LLM_API_KEY or FLANT_API_KEY)");
    if (flant.subscription) {
      if (readClaudeOAuthToken()) add("pass", "Claude OAuth token present for the personal subscription");
      else add("failure", "Subscription enabled but no Claude OAuth token (run /login → Anthropic)");
    }
    if (flant.copilotEnabled) {
      if (isCopilotTierActive(flant)) add("pass", "Copilot credentials present");
      else add("warning", "Copilot tier enabled but credentials are missing (run /login → GitHub Copilot or set COPILOT_GITHUB_TOKEN)");
    }
    add(flant.lastUpdated ? "pass" : "warning", `Model list last updated: ${flant.lastUpdated ?? "never"}`);

    const cacheDir = join(resolveAgentDir(), "extensions", "pp", "cache");
    try {
      mkdirSync(cacheDir, { recursive: true });
      const probe = join(cacheDir, `doctor-${Date.now()}.tmp`);
      writeFileSync(probe, "ok", "utf-8");
      unlinkSync(probe);
      add("pass", `Cache directory writable: ${cacheDir}`);
    } catch (error) {
      add("failure", `Cache directory is not writable: ${message(error)}`);
    }
  });

  category("Connectivity");
  const reachability: Array<[string, () => Promise<Response>]> = [
    ["GitHub releases", () => timedFetch("https://api.github.com/rate_limit", { headers: { "user-agent": "pi-pi" } }, 10_000)],
    ["npm registry", () => timedFetch("https://registry.npmjs.org/-/ping", {}, 10_000)],
    // Streamable HTTP requires both content types in Accept and a populated
    // initialize; without them the endpoint answers 406 and a reachable
    // service reads as down.
    ["Exa MCP", () => timedFetch("https://mcp.exa.ai/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "pi-pi", version: "1" } },
        id: 1,
      }),
    }, 10_000)],
  ];
  const flantKey = readGatewayApiKey();
  if (flantKey) {
    reachability.push(["Flant gateway", () => timedFetch("https://llm-api.flant.ru/v1/models", { headers: { Authorization: `Bearer ${flantKey}` } }, 10_000)]);
  }
  if (!probes) {
    add("pass", "Network probes skipped");
  } else {
    await Promise.all(reachability.map(async ([label, probe]) => {
      const started = Date.now();
      try {
        const response = await probe();
        const latency = Date.now() - started;
        add(response.ok ? "pass" : "failure", `${label}: ${response.ok ? `reachable (${latency}ms)` : `HTTP ${response.status} (${latency}ms)`}`);
      } catch (error) {
        add("failure", `${label}: unreachable — ${message(error)}`);
      }
    }));
  }

  category("Environment");
  add("pass", `Working directory: ${orchestrator.cwd}`);
  add(existsSync(join(orchestrator.cwd, ".git")) ? "pass" : "warning", "Working directory is a git repository");
  if (which("git") && existsSync(join(orchestrator.cwd, ".git"))) {
    await guard("Git status unreadable", () => {
      const status = execFileSync("git", ["status", "--porcelain", "--branch"], { cwd: orchestrator.cwd, encoding: "utf-8", stdio: "pipe" });
      const rows = status.split("\n").filter((line) => line.trim().length > 0);
      const branch = rows[0]?.startsWith("## ") ? rows[0].slice(3).trim() : "detached";
      const changes = rows[0]?.startsWith("## ") ? rows.length - 1 : rows.length;
      add("pass", `Branch ${branch}, ${changes} uncommitted change(s)`);
    });
  }
  add("pass", `Node ${process.version} on ${process.platform}-${process.arch}`);
  const retry = readProviderRetry();
  add(
    (retry.maxRetries ?? 0) > 3 ? "pass" : "warning",
    `Provider retries: ${retry.maxRetries ?? "pi's default"}, backoff ceiling ${retry.maxRetryDelayMs ?? "pi's default"}`,
  );

  lines.push("", `Summary: ${pass} passed, ${warn} warnings, ${fail} failures`);
  ctx.ui?.notify?.(lines.join("\n"), fail > 0 ? "error" : warn > 0 ? "warning" : "info");
}
