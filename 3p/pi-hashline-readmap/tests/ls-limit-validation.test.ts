import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function getLsTool() {
  const { registerLsTool } = await import("../src/ls.js");
  let captured: any = null;
  registerLsTool({ registerTool(def: any) { captured = def; } } as any);
  if (!captured) throw new Error("ls tool was not registered");
  return captured;
}

function text(result: any): string {
  return result.content?.find((c: any) => c.type === "text")?.text ?? "";
}

function makeDir() {
  const dir = mkdtempSync(join(tmpdir(), "ls-limit-"));
  writeFileSync(join(dir, "a.ts"), "");
  writeFileSync(join(dir, "b.ts"), "");
  return dir;
}

describe("ls limit validation", () => {
  it("rejects limit: 0", async () => {
    const dir = makeDir();
    try {
      const tool = await getLsTool();
      const result = await tool.execute("tc", { path: dir, limit: 0 },
        new AbortController().signal, undefined, { cwd: process.cwd() });
      expect(result.isError).toBe(true);
      expect(text(result)).toContain("Invalid limit: expected a positive integer, received 0.");
      expect(result.details?.ptcValue?.error?.code).toBe("invalid-limit");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("rejects limit: -5", async () => {
    const dir = makeDir();
    try {
      const tool = await getLsTool();
      const result = await tool.execute("tc", { path: dir, limit: -5 },
        new AbortController().signal, undefined, { cwd: process.cwd() });
      expect(result.isError).toBe(true);
      expect(text(result)).toContain("Invalid limit: expected a positive integer, received -5.");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("rejects non-numeric limit 'abc'", async () => {
    const dir = makeDir();
    try {
      const tool = await getLsTool();
      const result = await tool.execute("tc", { path: dir, limit: "abc" as any },
        new AbortController().signal, undefined, { cwd: process.cwd() });
      expect(result.isError).toBe(true);
      expect(text(result)).toContain("Invalid limit: expected a base-10 integer, received");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("regression: limit: 1 still caps and returns one entry", async () => {
    const dir = makeDir();
    try {
      const tool = await getLsTool();
      const result = await tool.execute("tc", { path: dir, limit: 1 },
        new AbortController().signal, undefined, { cwd: process.cwd() });
      expect(result.isError).toBeFalsy();
      expect(result.details?.ptcValue?.entries?.length).toBe(1);
      expect(result.details?.ptcValue?.truncated).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
