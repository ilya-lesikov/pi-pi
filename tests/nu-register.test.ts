import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { NU_GUIDELINES, NU_PTC } from "../src/nu.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

describe("NU_GUIDELINES", () => {
  const allText = NU_GUIDELINES.join("\n");

  it("contains routing guidance for both nu and bash", () => {
    expect(allText).toContain("bash");
    expect(allText).toContain("nu");
  });

  it("includes file exploration patterns", () => {
    expect(allText).toContain("ls");
    expect(allText).toContain("where");
    expect(allText).toContain("sort-by");
  });

  it("includes structured data access patterns", () => {
    expect(allText).toContain("open");
    expect(allText).toContain("get");
  });

  it("includes a plugin pointer block", () => {
    expect(allText).toContain("plugin list");
    expect(allText).toContain("gstat");
    expect(allText).toContain("query");
    expect(allText).toContain("formats");
  });

  it("includes key syntax reference", () => {
    expect(allText).toContain("length");
    expect(allText).toContain("math sum");
    expect(allText).toContain("group-by");
    expect(allText).toContain("first");
  });

  it("includes routing table with task-to-tool mappings", () => {
    expect(allText).toContain("Run tests");
    expect(allText).toContain("package.json");
  });
});

describe("NU_PTC", () => {
  it("is callable and read-only", () => {
    expect(NU_PTC.callable).toBe(true);
    expect(NU_PTC.readOnly).toBe(true);
  });

  it("has pythonName 'nu'", () => {
    expect(NU_PTC.pythonName).toBe("nu");
  });

  it("has read-only policy", () => {
    expect(NU_PTC.policy).toBe("read-only");
  });

  it("is opt-in by default", () => {
    expect(NU_PTC.defaultExposure).toBe("opt-in");
  });
});

afterEach(() => {
  vi.resetModules();
  vi.doUnmock("node:child_process");
});

describe("registerNuTool", () => {
  it("returns the registered tool definition when nushell is available", async () => {
    vi.resetModules();
    vi.doMock("node:child_process", async () => {
      const actual = await vi.importActual<any>("node:child_process");
      return {
        ...actual,
        execFileSync: vi.fn(() => Buffer.from("0.111.0\n")),
      };
    });
    const { registerNuTool } = await import("../src/nu.js");
    const pi = { registerTool: vi.fn() };
    const tool = registerNuTool(pi as any);
    expect(tool).toMatchObject({
      name: "nu",
      label: "nushell",
      ptc: NU_PTC,
    });
    expect(pi.registerTool).toHaveBeenCalledWith(tool);
  });

  it("returns false without calling pi.registerTool when nushell is unavailable", async () => {
    vi.resetModules();
    vi.doMock("node:child_process", async () => {
      const actual = await vi.importActual<any>("node:child_process");
      return {
        ...actual,
        execFileSync: vi.fn(() => {
          throw new Error("nu missing");
        }),
      };
    });

    const { registerNuTool } = await import("../src/nu.js");
    const pi = { registerTool: vi.fn() };

    expect(registerNuTool(pi as any)).toBe(false);
    expect(pi.registerTool).not.toHaveBeenCalled();
  });
});

describe("tool registration includes PTC metadata", () => {
  it("tool definition includes ptc: NU_PTC", () => {
    const src = readFileSync(resolve(__dirname, "../src/nu.ts"), "utf-8");
    expect(src).toMatch(/ptc:\s*NU_PTC/);
    expect(src).toContain("pi.registerTool(tool)");
  });
});
