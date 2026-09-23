/**
 * LSP server configuration.
 *
 * Built-in server definitions for popular languages. Servers are auto-detected
 * by checking if the binary is available on PATH. No user configuration needed.
 */

import { execFileSync } from 'node:child_process';

import type { LspServerUserConfig, ResolvedServerConfig } from './types';

// ── Built-in Servers ────────────────────────────────────────────────────────

const BUILTIN_SERVERS: Record<string, LspServerUserConfig> = {
  typescript: {
    command: ["typescript-language-server", "--stdio"],
    extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"],
  },
  go: {
    command: ["gopls"],
    extensions: [".go"],
  },
  rust: {
    command: ["rust-analyzer"],
    extensions: [".rs"],
  },
  python: {
    command: ["pyright-langserver", "--stdio"],
    extensions: [".py", ".pyi"],
  },
  clangd: {
    command: ["clangd"],
    extensions: [".c", ".h", ".cpp", ".hpp", ".cc", ".cxx", ".hxx", ".c++", ".h++"],
  },
  bash: {
    command: ["bash-language-server", "start"],
    extensions: [".sh", ".bash"],
  },
  lua: {
    command: ["lua-language-server"],
    extensions: [".lua"],
  },
  zig: {
    command: ["zls"],
    extensions: [".zig"],
  },
  kotlin: {
    command: ["kotlin-language-server"],
    extensions: [".kt", ".kts"],
  },
  ruby: {
    command: ["solargraph", "stdio"],
    extensions: [".rb", ".rake", ".gemspec"],
  },
  csharp: {
    command: ["csharp-ls"],
    extensions: [".cs"],
  },
  swift: {
    command: ["sourcekit-lsp"],
    extensions: [".swift"],
  },
  elixir: {
    command: ["elixir-ls"],
    extensions: [".ex", ".exs"],
  },
  java: {
    command: ["jdtls"],
    extensions: [".java"],
  },
};

// ── Resolution ──────────────────────────────────────────────────────────────

// LOCAL PATCH (pi-pi): `which` does not exist on native Windows, where the
// lookup is `where` — cmd.exe resolved neither, so every built-in failed
// detection and no language server was ever registered. Mirrors the same
// platform split in the orchestrator's cbm.ts/doctor.ts. execFileSync (argv,
// no shell) also keeps a server name out of shell-parsing reach.
function resolveCommandPath(command: string): string | null {
  try {
    const lookup = process.platform === 'win32' ? 'where' : 'which';
    const out = execFileSync(lookup, [command], {
      encoding: 'utf-8',
      stdio: 'pipe',
      timeout: 5_000,
    });
    // `where` prints every match, one per line; take the one that would win.
    return out.split('\n').map((line) => line.trim()).find((line) => line.length > 0) ?? null;
  } catch {
    return null;
  }
}

function resolveServer(
  name: string,
  config: LspServerUserConfig,
  _cwd: string,
): ResolvedServerConfig | null {
  if (!config.command || config.command.length === 0) return null;
  if (!config.extensions || config.extensions.length === 0) return null;

  const resolvedPath = resolveCommandPath(config.command[0]);
  if (!resolvedPath) return null;

  return {
    name,
    command: config.command[0],
    args: config.command.slice(1),
    extensions: config.extensions,
    env: config.env ?? {},
    initializationOptions: config.initialization ?? {},
    resolvedPath,
  };
}

// ── Public API ──────────────────────────────────────────────────────────────

export interface LoadedConfig {
  servers: ResolvedServerConfig[];
  globalDisabled: boolean;
  errors: string[];
}

export async function loadConfig(cwd: string): Promise<LoadedConfig> {
  const servers: ResolvedServerConfig[] = [];

  for (const [name, config] of Object.entries(BUILTIN_SERVERS)) {
    const resolved = resolveServer(name, config, cwd);
    if (resolved) {
      servers.push(resolved);
    }
  }

  return { servers, globalDisabled: false, errors: [] };
}

export function scaffoldGlobalConfig(_cwd: string): Promise<boolean> {
  return Promise.resolve(false);
}

// LOCAL PATCH (pi-pi): every built-in with its detection verdict, so /pp's
// doctor can say which language has no server and what binary it wanted,
// rather than silently omitting it from the detected set.
export interface BuiltinServerStatus {
  name: string;
  command: string[];
  extensions: string[];
  resolvedPath: string | null;
}

export function inspectBuiltinServers(): BuiltinServerStatus[] {
  return Object.entries(BUILTIN_SERVERS).map(([name, config]) => ({
    name,
    command: config.command ?? [],
    extensions: config.extensions ?? [],
    resolvedPath: config.command?.[0] ? resolveCommandPath(config.command[0]) : null,
  }));
}

export function serversForExtension(
  servers: ResolvedServerConfig[],
  filePath: string,
): ResolvedServerConfig[] {
  const ext = filePath.slice(filePath.lastIndexOf('.'));
  return servers.filter((s) => s.extensions.includes(ext));
}
