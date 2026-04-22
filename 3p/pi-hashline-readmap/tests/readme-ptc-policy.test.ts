import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

describe("README.md ptc policy docs", () => {
  const readme = readFileSync(resolve(root, "README.md"), "utf8");

  it("documents the expanded policy contract and recommended exposure tiers", () => {
    expect(readme).toContain("### PTC tool policy contract");
    expect(readme).toContain("`HASHLINE_TOOL_PTC_POLICY`");
    expect(readme).toContain("`read`, `grep`, `ls`, and `find` are safe-by-default and read-only");
    expect(readme).toContain("`ast_search` is opt-in and read-only");
    expect(readme).toContain("`edit` is not safe-by-default and is mutating");
    expect(readme).toContain("`pi-prompt-assembler` may optionally consume this contract");
  });

  it("documents the emitted executor surface", () => {
    expect(readme).toContain("## EventBus integration");
    expect(readme).toContain('pi.events.emit("hashline:tool-executors"');
    expect(readme).toContain("`read`, `edit`, `grep`, `ast_search`, `write`, `ls`, and `find`");
    expect(readme).toContain("`globalThis.__hashlineToolExecutors`");
  });
});
