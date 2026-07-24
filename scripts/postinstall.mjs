// Vendor-source decision: on non-Windows we invoke the existing bash `vendor.sh` UNCHANGED so
// Linux/CI stay byte-for-byte identical; on Windows we SKIP the bash vendor step (a documented
// Windows limitation) and rely on the npm-pack HTML fallback below. vendor.sh is still the single
// source used by `npm run build`/CI — this script does not fork its logic.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, copyFileSync, readdirSync } from "node:fs";
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

function extractHtmlFallback() {
  const tmp = mkdtempSync(join(tmpdir(), "pi-pi-plannotator-"));
  try {
    execFileSync("npm", ["pack", "@plannotator/pi-extension", "--pack-destination", tmp, "--silent"], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    const tgz = readdirSync(tmp).find((name) => name.endsWith(".tgz"));
    if (!tgz) fail("npm pack produced no tarball for @plannotator/pi-extension");
    execFileSync("tar", ["-xzf", join(tmp, tgz), "-C", tmp], { stdio: "pipe" });
    copyFileSync(join(tmp, "package", "plannotator.html"), join(PI_EXT_DIR, "plannotator.html"));
    copyFileSync(join(tmp, "package", "review-editor.html"), join(PI_EXT_DIR, "review-editor.html"));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

runVendor();

if (htmlPresent()) process.exit(0);

extractHtmlFallback();
