import { describe, it, expect } from "vitest";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { generateMap } from "../src/readmap/mapper.js";
import { SymbolKind } from "../src/readmap/enums.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(__dirname, "fixtures/sample.sh");

describe("Shell readmap mapper", () => {
  it("generates a map for .sh files", async () => {
    const map = await generateMap(FIXTURE);
    expect(map).not.toBeNull();
    expect(map!.language).toBe("Shell");
    expect(map!.symbols.length).toBeGreaterThan(0);
  });

  it("extracts 'function name()' style function", async () => {
    const map = await generateMap(FIXTURE);
    const deploy = map!.symbols.find(s => s.name === "deploy");
    expect(deploy).toBeDefined();
    expect(deploy!.kind).toBe(SymbolKind.Function);
    expect(deploy!.startLine).toBeGreaterThan(0);
    expect(deploy!.endLine).toBeGreaterThan(deploy!.startLine);
  });

  it("extracts 'name() {' style function", async () => {
    const map = await generateMap(FIXTURE);
    const build = map!.symbols.find(s => s.name === "build_image");
    expect(build).toBeDefined();
    expect(build!.kind).toBe(SymbolKind.Function);
    expect(build!.startLine).toBeGreaterThan(0);
    expect(build!.endLine).toBeGreaterThan(build!.startLine);
  });

  it("extracts 'function name {' style (no parens)", async () => {
    const map = await generateMap(FIXTURE);
    const cleanup = map!.symbols.find(s => s.name === "cleanup");
    expect(cleanup).toBeDefined();
    expect(cleanup!.kind).toBe(SymbolKind.Function);
  });

  it("extracts aliases as Variable kind", async () => {
    const map = await generateMap(FIXTURE);
    const ll = map!.symbols.find(s => s.name === "ll");
    expect(ll).toBeDefined();
    expect(ll!.kind).toBe(SymbolKind.Variable);
  });

  it("extracts exported variables as Variable kind", async () => {
    const map = await generateMap(FIXTURE);
    const appName = map!.symbols.find(s => s.name === "APP_NAME");
    expect(appName).toBeDefined();
    expect(appName!.kind).toBe(SymbolKind.Variable);
  });

  it("handles heredocs without misidentifying content as symbols", async () => {
    const map = await generateMap(FIXTURE);
    const genConfig = map!.symbols.find(s => s.name === "generate_config");
    expect(genConfig).toBeDefined();
    expect(genConfig!.kind).toBe(SymbolKind.Function);
    // The heredoc content (server, host, port, name) should NOT be symbols
    const server = map!.symbols.find(s => s.name === "server");
    expect(server).toBeUndefined();
  });

  it("symbol lookup by name returns function body", async () => {
    const map = await generateMap(FIXTURE);
    const runTests = map!.symbols.find(s => s.name === "run_tests");
    expect(runTests).toBeDefined();
    expect(runTests!.kind).toBe(SymbolKind.Function);
    expect(runTests!.startLine).toBeGreaterThan(0);
    expect(runTests!.endLine).toBeGreaterThan(runTests!.startLine);
  });
});
