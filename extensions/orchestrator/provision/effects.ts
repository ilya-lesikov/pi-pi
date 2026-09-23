/**
 * The real side effects behind ProvisionEffects. Kept apart from the decision
 * logic so tests exercise that logic without a network or a filesystem.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ProvisionEffects } from "./install.js";

const FETCH_TIMEOUT_MS = 120_000;

async function fetchWithTimeout(url: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      // GitHub's API rejects requests without one.
      headers: { "user-agent": "pi-pi", accept: "application/vnd.github+json" },
      redirect: "follow",
    });
    if (!response.ok) throw new Error(`GET ${url} → HTTP ${response.status}`);
    return response;
  } finally {
    clearTimeout(timer);
  }
}

export const nodeProvisionEffects: ProvisionEffects = {
  which(command) {
    try {
      const lookup = process.platform === "win32" ? "where" : "which";
      const out = execFileSync(lookup, [command], { encoding: "utf-8", stdio: "pipe", timeout: 5_000 });
      return out.split("\n").map((line) => line.trim()).find((line) => line.length > 0) ?? null;
    } catch {
      return null;
    }
  },

  async fetchBytes(url) {
    const response = await fetchWithTimeout(url);
    return Buffer.from(await response.arrayBuffer());
  },

  async fetchText(url) {
    const response = await fetchWithTimeout(url);
    return response.text();
  },

  run(command, args, options) {
    execFileSync(command, args, {
      cwd: options?.cwd,
      timeout: options?.timeoutMs ?? 300_000,
      stdio: "pipe",
      encoding: "utf-8",
    });
  },

  extract(archive, kind, binary, dir) {
    const staging = mkdtempSync(join(tmpdir(), "pi-pi-provision-"));
    const exe = process.platform === "win32" ? `${binary}.exe` : binary;

    if (kind === "gz") {
      const target = join(staging, exe);
      writeFileSync(target, gunzipSync(archive));
      return target;
    }

    const archivePath = join(staging, `archive.${kind}`);
    writeFileSync(archivePath, archive);

    if (kind === "tar.gz") {
      execFileSync("tar", ["-xf", archivePath, "-C", staging], { stdio: "pipe", timeout: 120_000 });
    } else if (kind === "zip") {
      // PowerShell is always present on Windows; unzip is not always present
      // elsewhere, so tar (which reads zip since bsdtar) is the safer default.
      if (process.platform === "win32") {
        execFileSync("powershell", ["-NoProfile", "-Command", `Expand-Archive -LiteralPath '${archivePath}' -DestinationPath '${staging}' -Force`], { stdio: "pipe", timeout: 120_000 });
      } else {
        execFileSync("tar", ["-xf", archivePath, "-C", staging], { stdio: "pipe", timeout: 120_000 });
      }
    } else if (kind !== "raw") {
      throw new Error(`unsupported archive kind: ${kind}`);
    }

    const found = findBinary(staging, exe);
    if (!found) throw new Error(`no ${exe} inside the downloaded archive`);
    return found;
  },
};

/** Release archives nest the binary under a versioned directory. */
function findBinary(root: string, name: string, depth = 0): string | null {
  if (depth > 3) return null;
  for (const entry of readdirSync(root)) {
    const path = join(root, entry);
    const stat = statSync(path);
    if (stat.isFile() && entry === name) return path;
    if (stat.isDirectory()) {
      const nested = findBinary(path, name, depth + 1);
      if (nested) return nested;
    }
  }
  return null;
}
