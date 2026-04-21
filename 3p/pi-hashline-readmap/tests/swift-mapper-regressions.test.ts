import { describe, it, expect, beforeEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { clearMapCache } from "../src/map-cache.js";

async function getReadTool() {
  const { registerReadTool } = await import("../src/read.js");
  let capturedTool: any = null;
  const mockPi = {
    registerTool(def: any) {
      capturedTool = def;
    },
  };
  registerReadTool(mockPi as any);
  if (!capturedTool) throw new Error("read tool was not registered");
  return capturedTool;
}

async function callReadTool(params: { path: string; map?: boolean }) {
  const tool = await getReadTool();
  return tool.execute("test-call", params, new AbortController().signal, () => {}, { cwd: process.cwd() });
}

async function withSwiftFile<T>(filename: string, content: string, run: (path: string) => Promise<T>) {
  const dir = await mkdtemp(join(tmpdir(), "swift-read-"));
  const file = join(dir, filename);
  try {
    await writeFile(file, content, "utf8");
    return await run(file);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
describe("Swift mapper regressions", () => {
  beforeEach(() => clearMapCache());

  it("read(path, { map: true }) maps actor declarations as container symbols with nested methods", async () => {
    const result = await withSwiftFile(
      "actor.swift",
      `actor BankAccount {
    var balance: Double = 0
    func deposit(_ amount: Double) {
        balance += amount
    }
}
`,
      async path => callReadTool({ path, map: true }),
    );

    const text = result.content[0].text;
    expect(text).toContain("File Map:");
    expect(text).toContain("class actor BankAccount: [1-6]");
    expect(text).toContain("  func deposit(_ amount: Double): [3-5]");
  });

  it("read(path, { map: true }) maps operator overloads as nested methods", async () => {
    const result = await withSwiftFile(
      "operator.swift",
      `struct Tricky {
    static func + (lhs: Tricky, rhs: Tricky) -> Tricky {
        return lhs
    }
}
`,
      async path => callReadTool({ path, map: true }),
    );

    const text = result.content[0].text;
    expect(text).toContain("File Map:");
    expect(text).toContain("class struct Tricky: [1-5]");
    expect(text).toContain("  static func + (lhs: Tricky, rhs: Tricky) -> Tricky: [2-4]");
  });

  it("read(path, { map: true }) maps deinit blocks as nested lifecycle symbols", async () => {
    const result = await withSwiftFile(
      "deinit.swift",
      `class ModernClass {
    deinit {
        print("bye")
    }
}
`,
      async path => callReadTool({ path, map: true }),
    );

    const text = result.content[0].text;
    expect(text).toContain("File Map:");
    expect(text).toContain("class class ModernClass: [1-5]");
    expect(text).toContain("  deinit: [2-4]");
  });
});
