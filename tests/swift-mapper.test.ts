import { describe, it, expect } from "vitest";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { generateMap } from "../src/readmap/mapper.js";
import { SymbolKind } from "../src/readmap/enums.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(__dirname, "fixtures/sample.swift");

describe("Swift readmap mapper", () => {
  it("generates a map for .swift files", async () => {
    const map = await generateMap(FIXTURE);
    expect(map).not.toBeNull();
    expect(map!.language).toBe("Swift");
    expect(map!.symbols.length).toBeGreaterThan(0);
  });

  it("extracts class as Class kind", async () => {
    const map = await generateMap(FIXTURE);
    const shape = map!.symbols.find(s => s.name === "Shape");
    expect(shape).toBeDefined();
    expect(shape!.kind).toBe(SymbolKind.Class);
    expect(shape!.startLine).toBeGreaterThan(0);
    expect(shape!.endLine).toBeGreaterThan(shape!.startLine);
  });

  it("extracts protocol as Interface kind", async () => {
    const map = await generateMap(FIXTURE);
    const drawable = map!.symbols.find(s => s.name === "Drawable");
    expect(drawable).toBeDefined();
    expect(drawable!.kind).toBe(SymbolKind.Interface);
  });

  it("extracts struct as Class kind", async () => {
    const map = await generateMap(FIXTURE);
    const point = map!.symbols.find(s => s.name === "Point");
    expect(point).toBeDefined();
    expect(point!.kind).toBe(SymbolKind.Class);
  });

  it("extracts enum as Enum kind", async () => {
    const map = await generateMap(FIXTURE);
    const dir = map!.symbols.find(s => s.name === "Direction");
    expect(dir).toBeDefined();
    expect(dir!.kind).toBe(SymbolKind.Enum);
  });

  it("extracts extension", async () => {
    const map = await generateMap(FIXTURE);
    const ext = map!.symbols.find(s => s.name === "Shape" && s.startLine > 20);
    // Extension should appear as a separate symbol
    expect(ext).toBeDefined();
  });

  it("extracts top-level function", async () => {
    const map = await generateMap(FIXTURE);
    const helper = map!.symbols.find(s => s.name === "globalHelper");
    expect(helper).toBeDefined();
    expect(helper!.kind).toBe(SymbolKind.Function);
  });
});
