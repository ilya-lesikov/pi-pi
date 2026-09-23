/**
 * What pi-pi can install for itself, and how trustworthy each source is.
 *
 * The agent's tool routing prefers code intelligence over shell search, but a
 * missing binary turned that preference into instructions to use a tool that
 * could only ever answer "unavailable" — so the model learned to abandon it and
 * fall back to grep. Provisioning removes the condition rather than teaching
 * the prompt to describe it.
 *
 * Verification is recorded per tool because it genuinely differs, and claiming
 * uniform integrity would be a lie about a supply chain:
 *   • `checksum`  — the publisher ships a digest beside the asset; we verify it.
 *   • `registry`  — npm verifies package integrity itself; nothing to add.
 *   • `toolchain` — an existing toolchain fetches and verifies its own component.
 *   • `none`      — transport integrity only. No published digest exists.
 */

export type VerificationKind = "checksum" | "registry" | "toolchain" | "none";

export type ProvisionSource =
  | { kind: "github"; repo: string; asset: AssetPattern; checksumAsset?: (asset: string) => string; archive: ArchiveKind }
  | { kind: "npm"; package: string; bin: string }
  | { kind: "toolchain"; command: string; args: string[]; requires: string };

/** Platform key: `${process.platform}-${process.arch}`. */
export type PlatformKey = string;

export interface AssetPattern {
  /**
   * Archive format per platform, where one platform is packed differently
   * from the rest. rust-analyzer ships .gz everywhere but Windows, where it
   * ships .zip, and feeding zip bytes to gunzip fails at extraction.
   */
  archiveByPlatform?: Record<PlatformKey, ArchiveKind>;
  /** Asset name per platform. Absent platform means "not published for it". */
  readonly byPlatform: Readonly<Record<PlatformKey, string>>;
}

export type ArchiveKind = "tar.gz" | "zip" | "gz" | "raw";

export interface ProvisionableTool {
  /** Binary name as it must appear on PATH. */
  readonly binary: string;
  /** Why the agent needs it — surfaced by the doctor, not to the model. */
  readonly purpose: string;
  /** Eager tools install at session start; lazy ones on first genuine need. */
  readonly eager: boolean;
  /** For a language server, the extensions it handles. Drives lazy triggering. */
  readonly extensions?: readonly string[];
  readonly source: ProvisionSource;
  readonly verification: VerificationKind;
}

const RIPGREP_ASSETS: Record<PlatformKey, string> = {
  "linux-x64": "ripgrep-{version}-x86_64-unknown-linux-musl.tar.gz",
  "linux-arm64": "ripgrep-{version}-aarch64-unknown-linux-gnu.tar.gz",
  "darwin-x64": "ripgrep-{version}-x86_64-apple-darwin.tar.gz",
  "darwin-arm64": "ripgrep-{version}-aarch64-apple-darwin.tar.gz",
  "win32-x64": "ripgrep-{version}-x86_64-pc-windows-msvc.zip",
  "win32-arm64": "ripgrep-{version}-aarch64-pc-windows-msvc.zip",
};

// Windows is the one platform these publishers pack as a zip.
const WINDOWS_ZIP: Record<PlatformKey, ArchiveKind> = {
  "win32-x64": "zip",
  "win32-arm64": "zip",
};

const RUST_ANALYZER_ASSETS: Record<PlatformKey, string> = {
  "linux-x64": "rust-analyzer-x86_64-unknown-linux-gnu.gz",
  "linux-arm64": "rust-analyzer-aarch64-unknown-linux-gnu.gz",
  "darwin-x64": "rust-analyzer-x86_64-apple-darwin.gz",
  "darwin-arm64": "rust-analyzer-aarch64-apple-darwin.gz",
  "win32-x64": "rust-analyzer-x86_64-pc-windows-msvc.zip",
  "win32-arm64": "rust-analyzer-aarch64-pc-windows-msvc.zip",
};

export const TOOLS: readonly ProvisionableTool[] = [
  {
    binary: "rg",
    purpose: "Fast search. The fallback every other retrieval path collapses to.",
    eager: true,
    source: {
      kind: "github",
      repo: "BurntSushi/ripgrep",
      asset: { byPlatform: RIPGREP_ASSETS, archiveByPlatform: WINDOWS_ZIP },
      checksumAsset: (asset) => `${asset}.sha256`,
      archive: "tar.gz",
    },
    verification: "checksum",
  },
  {
    binary: "codebase-memory-mcp",
    purpose: "Code graph: symbol search, call tracing, blast radius.",
    eager: true,
    source: { kind: "npm", package: "codebase-memory-mcp", bin: "codebase-memory-mcp" },
    verification: "registry",
  },
  {
    binary: "rust-analyzer",
    purpose: "Rust code intelligence.",
    eager: false,
    extensions: [".rs"],
    // rustup owns the Rust toolchain's version pairing; a standalone binary
    // beside a rustup toolchain can disagree with the project's Rust version.
    source: { kind: "toolchain", command: "rustup", args: ["component", "add", "rust-analyzer"], requires: "rustup" },
    verification: "toolchain",
  },
  {
    binary: "rust-analyzer",
    purpose: "Rust code intelligence (no rustup present).",
    eager: false,
    extensions: [".rs"],
    source: {
      kind: "github",
      repo: "rust-lang/rust-analyzer",
      asset: { byPlatform: RUST_ANALYZER_ASSETS, archiveByPlatform: WINDOWS_ZIP },
      archive: "gz",
    },
    // rust-analyzer publishes no digest beside its release assets.
    verification: "none",
  },
  {
    binary: "gopls",
    purpose: "Go code intelligence.",
    eager: false,
    extensions: [".go"],
    source: { kind: "toolchain", command: "go", args: ["install", "golang.org/x/tools/gopls@latest"], requires: "go" },
    verification: "toolchain",
  },
  {
    binary: "typescript-language-server",
    purpose: "TypeScript/JavaScript code intelligence.",
    eager: false,
    extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"],
    source: { kind: "npm", package: "typescript-language-server", bin: "typescript-language-server" },
    verification: "registry",
  },
  {
    binary: "pyright-langserver",
    purpose: "Python code intelligence.",
    eager: false,
    extensions: [".py", ".pyi"],
    source: { kind: "npm", package: "pyright", bin: "pyright-langserver" },
    verification: "registry",
  },
  {
    binary: "bash-language-server",
    purpose: "Shell code intelligence.",
    eager: false,
    extensions: [".sh", ".bash"],
    source: { kind: "npm", package: "bash-language-server", bin: "bash-language-server" },
    verification: "registry",
  },
];

export function platformKey(platform: string = process.platform, arch: string = process.arch): PlatformKey {
  return `${platform}-${arch}`;
}

/** Candidates for a binary, in preference order. */
export function toolsFor(binary: string): ProvisionableTool[] {
  return TOOLS.filter((tool) => tool.binary === binary);
}

export function eagerTools(): ProvisionableTool[] {
  return TOOLS.filter((tool) => tool.eager);
}

/**
 * Candidates able to serve a file, in preference order. A language with no
 * entry returns empty — that is a language pi-pi does not provision, which is
 * different from one whose install failed.
 */
export function toolsForExtension(extension: string): ProvisionableTool[] {
  return TOOLS.filter((tool) => tool.extensions?.includes(extension));
}

/** Whether this tool publishes an asset for the running platform. */
export function assetFor(tool: ProvisionableTool, key: PlatformKey, version: string): string | null {
  if (tool.source.kind !== "github") return null;
  const template = tool.source.asset.byPlatform[key];
  if (!template) return null;
  return template.replace(/\{version\}/g, version);
}

/** How this platform's asset is packed, which need not match the others'. */
export function archiveFor(tool: ProvisionableTool, key: PlatformKey): ArchiveKind {
  if (tool.source.kind !== "github") return "raw";
  return tool.source.asset.archiveByPlatform?.[key] ?? tool.source.archive;
}
