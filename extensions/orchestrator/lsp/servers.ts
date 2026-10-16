import { accessSync, constants, existsSync, readdirSync, statSync } from "node:fs";
import { delimiter, dirname, extname, isAbsolute, join, parse, relative, resolve } from "node:path";

/** How a language server is launched and which files it serves, as built in or written under `lsp.servers`. */
export interface ServerConfig {
  command?: string[];
  extensions?: string[];
  rootMarkers?: string[];
  enabled?: boolean;
  env?: Record<string, string>;
  initializationOptions?: Record<string, unknown>;
  settings?: Record<string, unknown>;
}

export interface ServerDef {
  name: string;
  command: string[];
  extensions: string[];
  rootMarkers: string[];
  env: Record<string, string>;
  initializationOptions?: Record<string, unknown>;
  settings?: Record<string, unknown>;
}

export const BUILTIN_SERVERS: Record<string, ServerConfig> = {
  typescript: {
    command: ["typescript-language-server", "--stdio"],
    extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"],
    rootMarkers: ["tsconfig.json", "jsconfig.json", "package.json"],
  },
  go: { command: ["gopls"], extensions: [".go"], rootMarkers: ["go.work", "go.mod"] },
  rust: { command: ["rust-analyzer"], extensions: [".rs"], rootMarkers: ["Cargo.toml"] },
  python: {
    command: ["pyright-langserver", "--stdio"],
    extensions: [".py", ".pyi"],
    rootMarkers: ["pyrightconfig.json", "pyproject.toml", "setup.py", "setup.cfg", "requirements.txt"],
  },
  clangd: {
    command: ["clangd"],
    extensions: [".c", ".h", ".cpp", ".hpp", ".cc", ".cxx", ".hxx", ".c++", ".h++"],
    rootMarkers: ["compile_commands.json", "compile_flags.txt", ".clangd", "CMakeLists.txt"],
  },
  bash: { command: ["bash-language-server", "start"], extensions: [".sh", ".bash"], rootMarkers: [] },
  lua: { command: ["lua-language-server"], extensions: [".lua"], rootMarkers: [".luarc.json", ".luarc.jsonc"] },
  zig: { command: ["zls"], extensions: [".zig"], rootMarkers: ["build.zig"] },
  kotlin: {
    command: ["kotlin-language-server"],
    extensions: [".kt", ".kts"],
    rootMarkers: ["settings.gradle.kts", "settings.gradle", "build.gradle.kts", "build.gradle", "pom.xml"],
  },
  ruby: { command: ["solargraph", "stdio"], extensions: [".rb", ".rake", ".gemspec"], rootMarkers: ["Gemfile"] },
  csharp: { command: ["csharp-ls"], extensions: [".cs"], rootMarkers: ["*.sln", "*.csproj"] },
  swift: { command: ["sourcekit-lsp"], extensions: [".swift"], rootMarkers: ["Package.swift"] },
  elixir: { command: ["elixir-ls"], extensions: [".ex", ".exs"], rootMarkers: ["mix.exs"] },
  java: { command: ["jdtls"], extensions: [".java"], rootMarkers: ["pom.xml", "build.gradle", "build.gradle.kts", "settings.gradle"] },
};

const LANGUAGE_IDS: Record<string, string> = {
  ".ts": "typescript", ".mts": "typescript", ".cts": "typescript", ".tsx": "typescriptreact",
  ".js": "javascript", ".mjs": "javascript", ".cjs": "javascript", ".jsx": "javascriptreact",
  ".py": "python", ".pyi": "python", ".go": "go", ".rs": "rust",
  ".c": "c", ".h": "c", ".cpp": "cpp", ".hpp": "cpp", ".cc": "cpp", ".cxx": "cpp", ".hxx": "cpp", ".c++": "cpp", ".h++": "cpp",
  ".sh": "shellscript", ".bash": "shellscript", ".lua": "lua", ".zig": "zig", ".kt": "kotlin", ".kts": "kotlin",
  ".rb": "ruby", ".rake": "ruby", ".gemspec": "ruby", ".cs": "csharp", ".swift": "swift", ".ex": "elixir", ".exs": "elixir", ".java": "java",
};

export function languageIdFor(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  return LANGUAGE_IDS[ext] ?? ext.slice(1);
}

export interface ResolvedServers {
  servers: ServerDef[];
  /** Servers whose definition is unusable, by name. */
  errors: string[];
  /** Project-defined commands not run because the project is not trusted. */
  untrusted: string[];
}

/**
 * Layers the global and project `lsp.servers` over the built-ins, field by
 * field: a same-named entry overrides only what it sets, and a new name must
 * give a command and extensions. A project pi does not trust may switch
 * servers off or narrow them, but not choose what runs: its `command` and
 * `env` are ignored.
 */
export function resolveServers(globalLayer: Record<string, ServerConfig> | undefined, projectLayer: Record<string, ServerConfig> | undefined, trusted: boolean): ResolvedServers {
  const errors: string[] = [];
  const untrusted: string[] = [];
  const servers: ServerDef[] = [];
  const names = new Set([...Object.keys(BUILTIN_SERVERS), ...Object.keys(globalLayer ?? {}), ...Object.keys(projectLayer ?? {})]);
  for (const name of names) {
    let project = projectLayer?.[name];
    if (project && !trusted && (project.command !== undefined || project.env !== undefined)) {
      untrusted.push(name);
      const { command: _command, env: _env, ...safe } = project;
      project = safe;
    }
    const merged: ServerConfig = { ...BUILTIN_SERVERS[name], ...globalLayer?.[name], ...project };
    if (merged.enabled === false) continue;
    if (!Array.isArray(merged.command) || merged.command.length === 0 || !merged.command[0]) {
      if (!untrusted.includes(name)) errors.push(`${name}: needs a non-empty command`);
      continue;
    }
    if (!Array.isArray(merged.extensions) || merged.extensions.length === 0) {
      errors.push(`${name}: needs at least one file extension`);
      continue;
    }
    servers.push({
      name,
      command: merged.command,
      extensions: merged.extensions.map((ext) => (ext.startsWith(".") ? ext : `.${ext}`).toLowerCase()),
      rootMarkers: merged.rootMarkers ?? [],
      env: merged.env ?? {},
      initializationOptions: merged.initializationOptions,
      settings: merged.settings,
    });
  }
  return { servers, errors, untrusted };
}

export function serversForFile(servers: ServerDef[], filePath: string): ServerDef[] {
  const ext = extname(filePath).toLowerCase();
  return ext ? servers.filter((server) => server.extensions.includes(ext)) : [];
}

function hasMarker(dir: string, marker: string): boolean {
  if (!marker.startsWith("*")) return existsSync(join(dir, marker));
  const suffix = marker.slice(1);
  try {
    return readdirSync(dir).some((entry) => entry.endsWith(suffix));
  } catch {
    return false;
  }
}

/**
 * The nearest directory at or above the file that holds one of the server's
 * root markers, searched no higher than the workspace when the file is inside
 * it. Without a marker the workspace itself is the root, which is what a
 * single-project checkout wants.
 */
export function findRoot(filePath: string, cwd: string, markers: string[]): string {
  const workspace = resolve(cwd);
  const absolute = resolve(workspace, filePath);
  if (markers.length === 0) return workspace;
  const inside = !relative(workspace, absolute).startsWith("..") && !isAbsolute(relative(workspace, absolute));
  const stop = inside ? workspace : parse(absolute).root;
  let dir = dirname(absolute);
  for (;;) {
    if (markers.some((marker) => hasMarker(dir, marker))) return dir;
    if (dir === stop) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return workspace;
}

/** Looks a command up on PATH without spawning anything; an absolute or relative path is checked as given. */
export function which(command: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const windows = process.platform === "win32";
  // npm puts an extensionless POSIX shell script beside each .cmd shim; on
  // Windows that script cannot be spawned, so the executable extensions win.
  const extensions = windows ? [...(env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean).map((ext) => ext.toLowerCase()), ""] : [""];
  const runnable = (candidate: string) => {
    try {
      if (!statSync(candidate).isFile()) return false;
      if (!windows) accessSync(candidate, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  };
  if (command.includes("/") || (windows && command.includes("\\"))) {
    for (const ext of extensions) if (runnable(command + ext)) return resolve(command + ext);
    return null;
  }
  for (const dir of (env.PATH ?? env.Path ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const ext of extensions) {
      const candidate = join(dir, command + ext);
      if (runnable(candidate)) return candidate;
    }
  }
  return null;
}
