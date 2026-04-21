import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGrepTool } from "@mariozechner/pi-coding-agent";
import { registerGrepTool } from "../src/grep.js";

function getText(result: any): string {
  return result.content?.find((c: any) => c.type === "text")?.text ?? "";
}

async function runBoth() {
  const dir = mkdtempSync(join(tmpdir(), "pi-grep-bloat-"));
  const filePath = join(dir, "big.txt");
  const line = "needle " + "x".repeat(20000);
  writeFileSync(filePath, Array.from({ length: 5 }, () => line).join("\n"), "utf8");

  const builtin = createGrepTool(process.cwd());
  let wrapped: any = null;
  registerGrepTool({ registerTool(def: any) { wrapped = def; } } as any);

  const builtinResult = await builtin.execute(
    "builtin",
    {
      pattern: "needle",
      path: filePath,
      literal: true,
      limit: 100,
    },
    new AbortController().signal,
    () => {},
  );

  const wrappedResult = await wrapped.execute(
    "wrapped",
    {
      pattern: "needle",
      path: filePath,
      literal: true,
      limit: 100,
    },
    new AbortController().signal,
    () => {},
    { cwd: process.cwd() },
  );

  return {
    builtinText: getText(builtinResult),
    wrappedText: getText(wrappedResult),
  };
}

describe("repro 093", () => {
  it("preserves builtin truncation notices after hashline transformation", async () => {
    const notice = "[Some lines truncated to 500 chars. Use read tool to see full lines]";
    const { builtinText, wrappedText } = await runBoth();
    expect(builtinText.includes(notice)).toBe(true);
    expect(wrappedText.includes(notice)).toBe(true);
  });
});
