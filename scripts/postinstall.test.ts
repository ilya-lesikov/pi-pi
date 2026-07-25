import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { vendorGeneratedNode } from "./postinstall.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EXT_DIR = join(REPO_ROOT, "3p", "pi-plannotator", "apps", "pi-extension");

function listFiles(root: string, dir: string = root): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...listFiles(root, full));
    else out.push(relative(root, full));
  }
  return out.sort();
}

// The Node port in postinstall.mjs reproduces vendor.sh for the Windows install path, where bash
// is unavailable. If the two ever diverge (a file added to vendor.sh's lists, a changed header or
// import rewrite), Windows silently ships a different extension than Linux/CI. This asserts they
// produce byte-for-byte identical generated/ trees. Bash-only, so skipped where it is absent.
describe("vendorGeneratedNode mirrors vendor.sh", () => {
  const hasBash = (() => {
    try {
      execFileSync("bash", ["--version"], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  })();

  it.skipIf(!hasBash)("produces a byte-for-byte identical generated/ tree", () => {
    const tmp = mkdtempSync(join(tmpdir(), "vendor-parity-"));
    try {
      // vendor.sh writes generated/ next to itself (gitignored, reproducible); snapshot it.
      execFileSync("bash", ["vendor.sh"], { cwd: EXT_DIR, stdio: "ignore" });
      const bashDir = join(EXT_DIR, "generated");

      const nodeDir = join(tmp, "generated");
      vendorGeneratedNode(nodeDir);

      const bashFiles = listFiles(bashDir);
      const nodeFiles = listFiles(nodeDir);
      expect(bashFiles.length).toBeGreaterThan(0);
      expect(nodeFiles).toEqual(bashFiles);

      for (const rel of bashFiles) {
        expect(readFileSync(join(nodeDir, rel), "utf8"), `content mismatch: ${rel}`).toBe(
          readFileSync(join(bashDir, rel), "utf8"),
        );
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
