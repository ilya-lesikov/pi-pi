import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

describe("doom-loop legacy exports removed", () => {
  it("src/doom-loop.ts no longer exports DOOM_LOOP_WARNING or appendDoomLoopWarning", () => {
    const src = readFileSync(new URL("../src/doom-loop.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/export\s+const\s+DOOM_LOOP_WARNING/);
    expect(src).not.toMatch(/export\s+function\s+appendDoomLoopWarning/);
  });

  it("index.ts no longer references appendDoomLoopWarning", () => {
    const idx = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
    expect(idx).not.toContain("appendDoomLoopWarning");
    expect(idx).not.toContain("DOOM_LOOP_WARNING");
  });

  it("importing the removed names from src/doom-loop.ts fails at module load", async () => {
    const mod: any = await import("../src/doom-loop.js");
    expect(mod.DOOM_LOOP_WARNING).toBeUndefined();
    expect(mod.appendDoomLoopWarning).toBeUndefined();
  });
});
