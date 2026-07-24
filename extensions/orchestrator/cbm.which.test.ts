import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  execFileSync: vi.fn(),
}));

vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("child_process")>();
  return { ...actual, execFileSync: mocks.execFileSync };
});

import { registerCbmTools } from "./cbm.js";

const CBM_BIN_KEY = Symbol.for("pi-pi:cbm-bin");
const CBM_DAEMON_KEY = Symbol.for("pi-pi:cbm-daemon");

function setPlatform(platform: NodeJS.Platform) {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
}

function seedFakeDaemon() {
  (globalThis as any)[CBM_DAEMON_KEY] = {
    ensureIndexed: vi.fn().mockResolvedValue("repo"),
    callTool: vi.fn().mockResolvedValue({}),
  };
}

describe("cbm platform-aware executable resolution", () => {
  const originalPlatform = process.platform;

  afterEach(() => {
    setPlatform(originalPlatform);
    (globalThis as any)[CBM_BIN_KEY] = undefined;
    (globalThis as any)[CBM_DAEMON_KEY] = undefined;
    mocks.execFileSync.mockReset();
    vi.restoreAllMocks();
  });

  it("uses `which` on posix and resolves the trimmed path", () => {
    setPlatform("linux");
    seedFakeDaemon();
    mocks.execFileSync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "which" && args[0] === "codebase-memory-mcp") return "/usr/bin/codebase-memory-mcp\n";
      throw new Error(`unexpected: ${cmd}`);
    });

    const registered = registerCbmTools({ registerTool: vi.fn() } as any, "/repo");

    expect(registered).toBe(true);
    expect(mocks.execFileSync).toHaveBeenCalledWith("which", ["codebase-memory-mcp"], expect.anything());
  });

  it("returns unavailable on posix when `which` throws (not found)", () => {
    setPlatform("linux");
    mocks.execFileSync.mockImplementation(() => {
      throw new Error("not found");
    });

    const registered = registerCbmTools({ registerTool: vi.fn() } as any, "/repo");

    expect(registered).toBe(false);
    expect(mocks.execFileSync).toHaveBeenCalledWith("which", ["codebase-memory-mcp"], expect.anything());
  });

  it("uses `where` on win32 and takes the first non-empty line", () => {
    setPlatform("win32");
    seedFakeDaemon();
    mocks.execFileSync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "where" && args[0] === "codebase-memory-mcp") {
        return "C:\\bin\\codebase-memory-mcp.exe\r\nC:\\other\\codebase-memory-mcp.exe\r\n";
      }
      throw new Error(`unexpected: ${cmd}`);
    });

    const registered = registerCbmTools({ registerTool: vi.fn() } as any, "/repo");

    expect(registered).toBe(true);
    expect(mocks.execFileSync).toHaveBeenCalledWith("where", ["codebase-memory-mcp"], expect.anything());
  });

  it("returns unavailable on win32 when `where` throws (not found)", () => {
    setPlatform("win32");
    mocks.execFileSync.mockImplementation(() => {
      throw new Error("INFO: Could not find files");
    });

    const registered = registerCbmTools({ registerTool: vi.fn() } as any, "/repo");

    expect(registered).toBe(false);
    expect(mocks.execFileSync).toHaveBeenCalledWith("where", ["codebase-memory-mcp"], expect.anything());
  });
});
