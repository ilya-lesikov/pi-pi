// Runs from INSIDE the installed package directory (import.meta.url is under the package), so
// dynamic import() of a bare specifier resolves through the installed artifact's own
// node_modules chain — the same resolution pi performs at extension load. Exits non-zero if a
// registered extension path is missing or a required runtime specifier fails to load.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PKG_DIR = dirname(fileURLToPath(import.meta.url));

function fail(msg) {
  console.error(`  ✗ ${msg}`);
  process.exitCode = 1;
}

const pkg = JSON.parse(readFileSync(join(PKG_DIR, "package.json"), "utf8"));

const extEntries = pkg?.pi?.extensions ?? [];
if (extEntries.length === 0) fail("package.json has no pi.extensions entries");
for (const entry of extEntries) {
  if (existsSync(resolve(PKG_DIR, entry))) {
    console.log(`  ✓ extension present: ${entry}`);
  } else {
    fail(`registered extension path missing from artifact: ${entry}`);
  }
}

// Bare specifiers pi itself supplies to loaded extensions — never mirrored into dependencies.
const peerSupplied = new Set(Object.keys(pkg.peerDependencies ?? {}));

function isBuiltin(spec) {
  return spec.startsWith("node:");
}
function isRelative(spec) {
  return spec.startsWith(".") || spec.startsWith("/");
}
function packageName(spec) {
  const parts = spec.split("/");
  return spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

function collectTsFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...collectTsFiles(full));
    else if (name.endsWith(".ts")) out.push(full);
  }
  return out;
}

// Scope the scan to the pi-subagents source only. Other shipped 3p sources reference SDK
// specifiers behind lazy `await import()` guards that are intentionally NOT root dependencies;
// scanning them would produce a permanently failing test.
const SCAN_DIR = join(PKG_DIR, "3p", "pi-subagents", "src");
if (!existsSync(SCAN_DIR)) {
  fail(`expected shipped source dir missing: 3p/pi-subagents/src`);
  process.exit(process.exitCode ?? 1);
}

// Value (non-type) import/export ... from "spec" and dynamic import("spec"). `import type` /
// `export type` statements are type-only and erased at build, so they carry no runtime requirement.
const FROM_RE = /(^|\n)\s*(import|export)\s+(?!type\b)(?:[^;]*?\sfrom\s+)?["']([^"']+)["']/g;
const DYN_RE = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;

const required = new Set();
for (const file of collectTsFiles(SCAN_DIR)) {
  const src = readFileSync(file, "utf8");
  for (const m of src.matchAll(FROM_RE)) addSpec(m[3]);
  for (const m of src.matchAll(DYN_RE)) addSpec(m[1]);
}
function addSpec(spec) {
  if (isBuiltin(spec) || isRelative(spec)) return;
  const name = packageName(spec);
  if (peerSupplied.has(name)) return;
  required.add(name);
}

// Floor: these two are the runtime imports that broke consumer installs; assert them explicitly
// even if the extractor's shape ever changes.
required.add("croner");
required.add("nanoid");

const specs = [...required].sort();
console.log(`  runtime specifiers to resolve: ${specs.join(", ")}`);

for (const spec of specs) {
  try {
    await import(spec);
    console.log(`  ✓ resolved: ${spec}`);
  } catch (err) {
    fail(`cannot resolve '${spec}' from installed package: ${err?.message ?? err}`);
  }
}

if (process.exitCode) {
  console.error("  → the root package is missing a runtime dependency its shipped extensions need.");
}
