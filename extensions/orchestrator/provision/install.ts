/**
 * Fetching the binaries pi-pi wants, and recording honestly how each arrived.
 *
 * Every side effect is injected. The decision logic — what to fetch, whether a
 * digest matched, what to report — is then testable without a network, which
 * matters more here than usual: the failure this exists to prevent is a tool
 * that looks available and is not.
 */

import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { assetFor, platformKey, type ProvisionableTool, type VerificationKind } from "./manifest.js";

export interface ProvisionEffects {
  /** Resolve a command on PATH, or null. */
  which: (command: string) => string | null;
  /** Fetch a URL, returning its bytes, or throw. */
  fetchBytes: (url: string) => Promise<Buffer>;
  /** Fetch a URL as text, or throw. */
  fetchText: (url: string) => Promise<string>;
  /** Run a command to completion; throw on non-zero exit. */
  run: (command: string, args: string[], options?: { cwd?: string; timeoutMs?: number }) => void;
  /** Unpack `archive` into `dir`, returning the path of the extracted binary. */
  extract: (archive: Buffer, kind: string, binary: string, dir: string) => string;
}

export type ProvisionOutcome =
  | { status: "present"; binary: string; path: string }
  | { status: "installed"; binary: string; path: string; verification: VerificationKind; version: string }
  | { status: "unavailable"; binary: string; reason: string }
  | { status: "failed"; binary: string; reason: string };

export function provisionDir(): string {
  const configured = process.env.PI_PI_BIN_DIR;
  if (configured) return configured;
  const agentDir = process.env.PI_CODING_AGENT_DIR;
  const base = agentDir
    ? (agentDir === "~" ? homedir() : agentDir.startsWith("~/") ? join(homedir(), agentDir.slice(2)) : agentDir)
    : join(homedir(), ".pi", "agent");
  return join(base, "extensions", "pp", "bin");
}

async function latestRelease(effects: ProvisionEffects, repo: string): Promise<{ version: string; assets: Record<string, string> }> {
  const body = await effects.fetchText(`https://api.github.com/repos/${repo}/releases/latest`);
  const release = JSON.parse(body) as { tag_name?: string; assets?: Array<{ name?: string; browser_download_url?: string }> };
  const version = (release.tag_name ?? "").replace(/^v/, "");
  if (!version) throw new Error(`no tag_name in the latest release of ${repo}`);
  const assets: Record<string, string> = {};
  for (const asset of release.assets ?? []) {
    if (asset?.name && asset.browser_download_url) assets[asset.name] = asset.browser_download_url;
  }
  return { version, assets };
}

/**
 * A published digest is a line of the form "<sha256>  <filename>"; some
 * publishers ship the bare digest instead. Both are accepted, anything else is
 * treated as no digest at all rather than guessed at.
 */
export function parseChecksum(text: string): string | null {
  const first = text.trim().split("\n")[0]?.trim() ?? "";
  const token = first.split(/\s+/)[0] ?? "";
  return /^[0-9a-f]{64}$/i.test(token) ? token.toLowerCase() : null;
}

export function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function installFromGithub(
  effects: ProvisionEffects,
  tool: ProvisionableTool,
  dir: string,
): Promise<ProvisionOutcome> {
  if (tool.source.kind !== "github") throw new Error("not a github source");
  const { version, assets } = await latestRelease(effects, tool.source.repo);
  const wanted = assetFor(tool, platformKey(), version);
  if (!wanted) {
    return { status: "unavailable", binary: tool.binary, reason: `${tool.source.repo} publishes no asset for ${platformKey()}` };
  }
  const url = assets[wanted];
  if (!url) {
    return { status: "unavailable", binary: tool.binary, reason: `release ${version} of ${tool.source.repo} has no asset named ${wanted}` };
  }

  const bytes = await effects.fetchBytes(url);

  let verification: VerificationKind = "none";
  if (tool.source.checksumAsset) {
    const checksumName = tool.source.checksumAsset(wanted);
    const checksumUrl = assets[checksumName];
    if (checksumUrl) {
      const expected = parseChecksum(await effects.fetchText(checksumUrl));
      if (!expected) {
        return { status: "failed", binary: tool.binary, reason: `could not parse the published digest in ${checksumName}` };
      }
      const actual = sha256(bytes);
      if (actual !== expected) {
        // Never install a mismatch: it is either corruption or tampering, and
        // both are reasons to stop rather than to retry.
        return { status: "failed", binary: tool.binary, reason: `digest mismatch for ${wanted}: expected ${expected}, got ${actual}` };
      }
      verification = "checksum";
    }
  }

  mkdirSync(dir, { recursive: true });
  const extracted = effects.extract(bytes, tool.source.archive, tool.binary, dir);
  const final = join(dir, process.platform === "win32" ? `${tool.binary}.exe` : tool.binary);
  if (extracted !== final) renameSync(extracted, final);
  if (process.platform !== "win32") chmodSync(final, 0o755);

  return { status: "installed", binary: tool.binary, path: final, verification, version };
}

function installFromNpm(effects: ProvisionEffects, tool: ProvisionableTool, dir: string): ProvisionOutcome {
  if (tool.source.kind !== "npm") throw new Error("not an npm source");
  if (!effects.which("npm")) {
    return { status: "unavailable", binary: tool.binary, reason: "npm is not on PATH" };
  }
  mkdirSync(dir, { recursive: true });
  const prefix = join(dir, "node");
  // A private prefix keeps this out of the user's global npm root: pi-pi
  // installing a tool is not a reason to modify a shared environment.
  effects.run("npm", ["install", "--prefix", prefix, "--no-audit", "--no-fund", tool.source.package], { timeoutMs: 300_000 });
  const binPath = join(prefix, "node_modules", ".bin", process.platform === "win32" ? `${tool.source.bin}.cmd` : tool.source.bin);
  if (!existsSync(binPath)) {
    return { status: "failed", binary: tool.binary, reason: `npm installed ${tool.source.package} but ${binPath} is missing` };
  }
  return { status: "installed", binary: tool.binary, path: binPath, verification: "registry", version: "latest" };
}

function installFromToolchain(effects: ProvisionEffects, tool: ProvisionableTool): ProvisionOutcome {
  if (tool.source.kind !== "toolchain") throw new Error("not a toolchain source");
  if (!effects.which(tool.source.requires)) {
    return { status: "unavailable", binary: tool.binary, reason: `${tool.source.requires} is not on PATH` };
  }
  effects.run(tool.source.command, tool.source.args, { timeoutMs: 600_000 });
  const path = effects.which(tool.binary);
  if (!path) {
    // The toolchain reported success and the binary still is not reachable —
    // exactly the rustup-proxy shape, where a name resolves but nothing runs.
    return { status: "failed", binary: tool.binary, reason: `${tool.source.command} succeeded but ${tool.binary} is still not on PATH` };
  }
  return { status: "installed", binary: tool.binary, path, verification: "toolchain", version: "latest" };
}

/**
 * Install one tool, trying its candidates in manifest order.
 *
 * Returns `present` without touching the network when the binary already
 * resolves — provisioning must never shadow a working install the user chose.
 */
export async function provision(
  effects: ProvisionEffects,
  candidates: ProvisionableTool[],
  dir: string = provisionDir(),
): Promise<ProvisionOutcome> {
  if (candidates.length === 0) return { status: "unavailable", binary: "?", reason: "no candidate is declared for it" };

  const binary = candidates[0].binary;
  const existing = effects.which(binary);
  if (existing) return { status: "present", binary, path: existing };

  const reasons: string[] = [];
  for (const tool of candidates) {
    try {
      const outcome = tool.source.kind === "github"
        ? await installFromGithub(effects, tool, dir)
        : tool.source.kind === "npm"
          ? installFromNpm(effects, tool, dir)
          : installFromToolchain(effects, tool);
      if (outcome.status === "installed") return outcome;
      reasons.push(outcome.status === "unavailable" || outcome.status === "failed" ? outcome.reason : "");
    } catch (error: any) {
      reasons.push(error?.message ?? String(error));
    }
  }
  return { status: "failed", binary, reason: reasons.filter(Boolean).join("; ") };
}
