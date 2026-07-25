// Vendor-source decision: on non-Windows we invoke the existing bash `vendor.sh` UNCHANGED so
// Linux/CI stay byte-for-byte identical. On Windows bash is unavailable, so we reproduce
// vendor.sh's logic in Node (`vendorGeneratedNode`) from the same pinned sources shipped in this
// package's tarball, then recover the prebuilt HTML via the npm-pack fallback below. vendor.sh
// remains the single source used by `npm run build`/CI; the Node port must mirror it exactly.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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
    console.log("  ⚠ bash vendor.sh unavailable on Windows — vendoring generated/ with Node fallback");
    vendorGeneratedNode();
    return;
  }
  const res = spawnSync("bash", [join(PI_EXT_DIR, "vendor.sh")], { cwd: REPO_ROOT, stdio: "inherit" });
  if (res.status !== 0) fail(`vendor.sh failed with exit code ${res.status ?? "unknown"}`);
}

// Node port of vendor.sh: prepend the @generated header to each pinned source and rewrite the
// server/tour imports to the flat generated/ layout. MUST stay in lockstep with vendor.sh —
// same file lists, same header, same import rewrites — or Windows ships a divergent extension.
export function vendorGeneratedNode(genDir = join(PI_EXT_DIR, "generated")) {
  const PKG_ROOT = join(REPO_ROOT, "3p", "pi-plannotator", "packages");
  const GEN = genDir;

  const SHARED = [
    "feedback-templates", "prompts", "review-core", "diff-paths", "jj-core", "vcs-core", "review-args",
    "storage", "draft", "project", "pr-types", "pr-provider", "pr-stack", "pr-github", "pr-gitlab",
    "checklist", "integrations-common", "repo", "reference-common", "favicon", "code-file",
    "resolve-file", "config", "external-annotation", "agent-jobs", "worktree", "worktree-pool",
    "html-to-markdown", "url-to-markdown", "tour", "annotate-args", "at-reference",
    "review-workspace-node", "review-workspace", "pfm-reminder", "improvement-hooks", "code-nav",
    "data-dir", "semantic-diff-types", "semantic-diff",
  ];
  const SERVER = ["agent-review-message", "codex-review", "claude-review", "path-utils"];
  const AI = ["index", "types", "provider", "session-manager", "endpoints", "context", "base-session"];
  const PROVIDERS = ["claude-agent-sdk", "codex-sdk", "opencode-sdk", "command-path", "pi-sdk", "pi-sdk-node", "pi-events"];

  const SERVER_REWRITES = [
    ['from "./vcs"', 'from "./review-core.js"'],
    ['from "./pr"', 'from "./pr-provider.js"'],
    ['from "./path-utils"', 'from "./path-utils.js"'],
    ['from "@plannotator/shared/review-workspace"', 'from "./review-workspace.js"'],
    ['from "@plannotator/shared/data-dir"', 'from "./data-dir"'],
  ];
  const TOUR_REWRITES = [
    ['from "../vcs"', 'from "./review-core.js"'],
    ['from "../pr"', 'from "./pr-provider.js"'],
    ['from "../agent-review-message"', 'from "./agent-review-message.js"'],
    ['from "@plannotator/shared/tour"', 'from "./tour.js"'],
    ['from "@plannotator/shared/data-dir"', 'from "./data-dir"'],
  ];

  const header = (rel) => `// @generated — DO NOT EDIT. Source: ${rel}\n`;
  const apply = (src, rewrites) => rewrites.reduce((acc, [from, to]) => acc.split(from).join(to), src);
  const emit = (srcAbs, rel, outAbs, rewrites) => {
    if (!existsSync(srcAbs)) fail(`vendor source missing: ${rel}`);
    const body = readFileSync(srcAbs, "utf8");
    writeFileSync(outAbs, header(rel) + (rewrites ? apply(body, rewrites) : body));
  };

  rmSync(GEN, { recursive: true, force: true });
  mkdirSync(join(GEN, "ai", "providers"), { recursive: true });

  for (const f of SHARED) emit(join(PKG_ROOT, "shared", `${f}.ts`), `packages/shared/${f}.ts`, join(GEN, `${f}.ts`));
  for (const f of SERVER) emit(join(PKG_ROOT, "server", `${f}.ts`), `packages/server/${f}.ts`, join(GEN, `${f}.ts`), SERVER_REWRITES);
  emit(join(PKG_ROOT, "server", "tour", "tour-review.ts"), "packages/server/tour/tour-review.ts", join(GEN, "tour-review.ts"), TOUR_REWRITES);
  for (const f of AI) emit(join(PKG_ROOT, "ai", `${f}.ts`), `packages/ai/${f}.ts`, join(GEN, "ai", `${f}.ts`));
  for (const f of PROVIDERS) emit(join(PKG_ROOT, "ai", "providers", `${f}.ts`), `packages/ai/providers/${f}.ts`, join(GEN, "ai", "providers", `${f}.ts`));
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

// Skip the install-time side effects when imported by a test; only run as the lifecycle script.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  runVendor();
  if (!htmlPresent()) extractHtmlFallback();
}
