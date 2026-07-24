// Vendor-source decision: on non-Windows we invoke the existing bash `vendor.sh` UNCHANGED so
// Linux/CI stay byte-for-byte identical; on Windows we SKIP the bash vendor step (a documented
// Windows limitation) and rely on the npm-pack HTML fallback below. vendor.sh is still the single
// source used by `npm run build`/CI — this script does not fork its logic.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");
const PI_EXT_DIR = join(REPO_ROOT, "3p", "pi-plannotator", "apps", "pi-extension");
const isWindows = process.platform === "win32";

function fail(msg) {
  console.error(`  ✗ ${msg}`);
  process.exit(1);
}

function runVendor() {
  if (isWindows) {
    console.log("  ⚠ skipping plannotator vendor step on Windows (bash vendor.sh unavailable)");
    return;
  }
  const res = spawnSync("bash", [join(PI_EXT_DIR, "vendor.sh")], { cwd: REPO_ROOT, stdio: "inherit" });
  if (res.status !== 0) fail(`vendor.sh failed with exit code ${res.status ?? "unknown"}`);
}

function htmlPresent() {
  return existsSync(join(PI_EXT_DIR, "plannotator.html")) && existsSync(join(PI_EXT_DIR, "review-editor.html"));
}

// Extract a specific file from an npm tarball (gzipped POSIX/ustar tar) using only
// Node builtins — no external `tar` executable, which is not guaranteed on native
// Windows. Returns the file's bytes, or null when the entry is absent.
function extractFromTar(tarBytes, wantPath) {
  let off = 0;
  while (off + 512 <= tarBytes.length) {
    const header = tarBytes.subarray(off, off + 512);
    const name = header.subarray(0, 100).toString("utf-8").replace(/\0.*$/, "");
    if (name === "") break;
    const size = parseInt(header.subarray(124, 136).toString("utf-8").replace(/\0.*$/, "").trim() || "0", 8);
    const dataStart = off + 512;
    if (name === wantPath) return tarBytes.subarray(dataStart, dataStart + size);
    off = dataStart + Math.ceil(size / 512) * 512;
  }
  return null;
}

// Run `npm pack` without depending on PATH/PATHEXT resolution of `npm`, which on
// Windows is `npm.cmd` and cannot be spawned by execFileSync without a shell
// (Node rejects .cmd without shell:true). In a lifecycle script npm exports
// npm_execpath (the CLI's JS entry); run it with the current node. Fall back to a
// shell-resolved `npm`/`npm.cmd` only if that env var is somehow absent.
function runNpmPack(destDir) {
  const npmCli = process.env.npm_execpath;
  if (npmCli) {
    execFileSync(process.execPath, [npmCli, "pack", "@plannotator/pi-extension", "--pack-destination", destDir, "--silent"], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    return;
  }
  const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
  execFileSync(npmCmd, ["pack", "@plannotator/pi-extension", "--pack-destination", destDir, "--silent"], {
    stdio: ["ignore", "ignore", "ignore"],
    shell: true,
  });
}

function extractHtmlFallback() {
  const tmp = mkdtempSync(join(tmpdir(), "pi-pi-plannotator-"));
  try {
    runNpmPack(tmp);
    const tgz = readdirSync(tmp).find((name) => name.endsWith(".tgz"));
    if (!tgz) fail("npm pack produced no tarball for @plannotator/pi-extension");
    const tarBytes = gunzipSync(readFileSync(join(tmp, tgz)));
    for (const file of ["plannotator.html", "review-editor.html"]) {
      const bytes = extractFromTar(tarBytes, `package/${file}`);
      if (!bytes) fail(`@plannotator/pi-extension tarball is missing ${file}`);
      writeFileSync(join(PI_EXT_DIR, file), bytes);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

runVendor();

if (htmlPresent()) process.exit(0);

extractHtmlFallback();
