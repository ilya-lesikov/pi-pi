import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

const ENTRY_POINTS = ["src/core/summarize.ts", "src/tools/recall.ts"];
const FORBIDDEN = "@earendil-works/pi-agent-core";

const resolveModule = (fromFile: string, spec: string): string | undefined => {
  if (!spec.startsWith(".")) return undefined;
  const base = resolve(dirname(fromFile), spec);
  for (const candidate of [`${base}.ts`, resolve(base, "index.ts")]) {
    try {
      readFileSync(candidate);
      return candidate;
    } catch {
      /* try next */
    }
  }
  return undefined;
};

const collectImports = (file: string): string[] => {
  const src = readFileSync(file, "utf-8");
  const specs: string[] = [];
  const re = /(?:import|export)\b[^;]*?\bfrom\s*["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) specs.push(m[1]);
  const dyn = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
  while ((m = dyn.exec(src))) specs.push(m[1]);
  return specs;
};

const walkClosure = (): { files: Set<string>; imports: Map<string, string[]> } => {
  const files = new Set<string>();
  const imports = new Map<string, string[]>();
  const queue = ENTRY_POINTS.map((e) => resolve(root, e));
  while (queue.length) {
    const file = queue.pop()!;
    if (files.has(file)) continue;
    files.add(file);
    const specs = collectImports(file);
    imports.set(file, specs);
    for (const spec of specs) {
      const dep = resolveModule(file, spec);
      if (dep && !files.has(dep)) queue.push(dep);
    }
  }
  return { files, imports };
};

describe("retained closure import guard", () => {
  const { files, imports } = walkClosure();

  it("reaches the expected retained modules", () => {
    expect(files.size).toBeGreaterThan(10);
    expect([...files].some((f) => f.endsWith("src/core/summarize.ts"))).toBe(true);
    expect([...files].some((f) => f.endsWith("src/tools/recall.ts"))).toBe(true);
  });

  it("no reachable module imports @earendil-works/pi-agent-core", () => {
    const offenders: string[] = [];
    for (const [file, specs] of imports) {
      if (specs.some((s) => s === FORBIDDEN || s.startsWith(`${FORBIDDEN}/`))) {
        offenders.push(file.replace(`${root}/`, ""));
      }
    }
    expect(offenders, `pi-agent-core reached from retained closure: ${offenders.join(", ")}`).toEqual([]);
  });

  it("does not vendor the excluded hook/command/invisible-continue modules", () => {
    for (const excluded of [
      "src/hooks/before-compact.ts",
      "src/hooks/proactive-threshold.ts",
      "src/core/invisible-continue.ts",
      "src/core/settings.ts",
    ]) {
      expect(
        () => readFileSync(resolve(root, excluded)),
        `${excluded} must NOT be vendored`,
      ).toThrow();
    }
  });
});
