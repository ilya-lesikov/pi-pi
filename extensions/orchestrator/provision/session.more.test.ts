import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
  which: (_command: string): string | null => null,
  fetchText: async (_url: string): Promise<string> => { throw new Error("offline"); },
  run: (_command: string, _args: string[]) => {},
}));

vi.mock("./effects.js", () => ({
  nodeProvisionEffects: {
    which: (command: string) => fake.which(command),
    fetchText: (url: string) => fake.fetchText(url),
    fetchBytes: async () => { throw new Error("offline"); },
    run: (command: string, args: string[]) => fake.run(command, args),
    extract: () => { throw new Error("unused"); },
  },
}));

import { ensureServerForFile, ensureTool, provisionEagerTools, provisionResults } from "./session.js";

let binDir: string;
const originalPath = process.env.PATH;

beforeEach(() => {
  binDir = mkdtempSync(join(tmpdir(), "pp-session-bin-"));
  process.env.PI_PI_BIN_DIR = binDir;
  // The per-process caches live on globalThis so they survive module reloads; reset them per test.
  delete (globalThis as any)[Symbol.for("pi-pi:provision-results")];
  delete (globalThis as any)[Symbol.for("pi-pi:provision-inflight")];
});

afterEach(() => {
  delete process.env.PI_PI_BIN_DIR;
  process.env.PATH = originalPath;
  fake.which = () => null;
  fake.fetchText = async () => { throw new Error("offline"); };
  fake.run = () => {};
  rmSync(binDir, { recursive: true, force: true });
});

describe("ensureTool", () => {
  it("reports a binary already on PATH as present and remembers it", async () => {
    const which = vi.fn((command: string) => (command === "rg" ? "/usr/bin/rg" : null));
    fake.which = which;
    expect(await ensureTool("rg")).toEqual({ status: "present", binary: "rg", path: "/usr/bin/rg" });
    await ensureTool("rg");
    expect(which).toHaveBeenCalledTimes(1);
    expect(provisionResults()).toEqual([{ status: "present", binary: "rg", path: "/usr/bin/rg" }]);
  });

  it("runs one install for concurrent requests of the same binary", async () => {
    let release!: (text: string) => void;
    const fetchText = vi.fn(() => new Promise<string>((resolve) => { release = resolve; }));
    fake.fetchText = fetchText;
    const first = ensureTool("rg");
    const second = ensureTool("rg");
    await vi.waitFor(() => expect(fetchText).toHaveBeenCalledTimes(1));
    release(JSON.stringify({ tag_name: "v1.0.0", assets: [] }));
    const [a, b] = await Promise.all([first, second]);
    expect(a).toBe(b);
    expect(a.status).toBe("failed");
    expect(fetchText).toHaveBeenCalledTimes(1);
  });

  it("records a failed install instead of throwing, and does not retry it", async () => {
    const fetchText = vi.fn(async () => { throw new Error("network down"); });
    fake.fetchText = fetchText;
    const outcome = await ensureTool("rg");
    expect(outcome).toMatchObject({ status: "failed", binary: "rg" });
    expect((outcome as any).reason).toContain("network down");
    await ensureTool("rg");
    expect(fetchText).toHaveBeenCalledTimes(1);
  });

  it("logs and returns an installed outcome", async () => {
    fake.which = (command) => (command === "npm" ? "/usr/bin/npm" : null);
    fake.run = (_command, args) => {
      const prefix = args[args.indexOf("--prefix") + 1];
      const bin = join(prefix, "node_modules", ".bin");
      mkdirSync(bin, { recursive: true });
      writeFileSync(join(bin, "bash-language-server"), "");
    };
    const outcome = await ensureTool("bash-language-server");
    expect(outcome).toMatchObject({ status: "installed", verification: "registry" });
  });

  it("turns a crash in the install pipeline into a failed outcome", async () => {
    fake.which = () => { throw new Error("which exploded"); };
    expect(await ensureTool("rg")).toEqual({ status: "failed", binary: "rg", reason: "which exploded" });
  });
});

describe("ensureServerForFile", () => {
  it("returns null for a language pi-pi does not provision", async () => {
    expect(await ensureServerForFile("/x/notes.unknownext")).toBeNull();
  });

  it("provisions the first server declared for the extension", async () => {
    fake.which = (command) => (command === "gopls" ? "/go/bin/gopls" : null);
    expect(await ensureServerForFile("/x/main.go")).toEqual({ status: "present", binary: "gopls", path: "/go/bin/gopls" });
  });
});

describe("provisionEagerTools", () => {
  it("puts the bin dir on PATH and reports only newly installed tools", async () => {
    process.env.PATH = "/usr/bin";
    fake.which = (command) => (command === "rg" ? "/usr/bin/rg" : command === "npm" ? "/usr/bin/npm" : null);
    fake.run = (_command, args) => {
      const prefix = args[args.indexOf("--prefix") + 1];
      const bin = join(prefix, "node_modules", ".bin");
      mkdirSync(bin, { recursive: true });
      writeFileSync(join(bin, "codebase-memory-mcp"), "");
    };
    const installed = await provisionEagerTools();
    expect(installed.map((outcome) => outcome.binary)).toEqual(["codebase-memory-mcp"]);
    expect(process.env.PATH!.split(":")).toContain(binDir);
  });
});
