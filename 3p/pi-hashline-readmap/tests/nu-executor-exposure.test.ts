import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

function createMockPi() {
  return {
    registerTool: vi.fn(),
    events: { emit: vi.fn(), on: vi.fn() },
    on: vi.fn(),
  };
}

describe("nu executor exposure", () => {
  beforeEach(() => {
    delete (globalThis as any).__hashlineToolExecutors;
    vi.resetModules();
  });

  afterEach(() => {
    vi.doUnmock("../src/nu.js");
    vi.resetModules();
  });

  it("includes nu in the stashed and emitted executor object when registerNuTool returns a tool", async () => {
    vi.doMock("../src/nu.js", async () => {
      const actual = await vi.importActual<any>("../src/nu.js");
      return {
        ...actual,
        registerNuTool: vi.fn(() => ({
          name: "nu",
          label: "nushell",
          description: "nu tool",
          parameters: {},
          execute: vi.fn(),
        })),
      };
    });

    const pi = createMockPi();
    const { default: init } = await import("../index.js");
    init(pi as any);

    const stash = (globalThis as any).__hashlineToolExecutors;
    const payload = pi.events.emit.mock.calls.find(
      (call: any[]) => call[0] === "hashline:tool-executors"
    )?.[1] as Record<string, any>;

    expect(stash.nu).toMatchObject({ name: "nu" });
    expect(payload.nu).toMatchObject({ name: "nu" });
  });

  it("omits nu without throwing when registerNuTool returns false", async () => {
    vi.doMock("../src/nu.js", async () => {
      const actual = await vi.importActual<any>("../src/nu.js");
      return {
        ...actual,
        registerNuTool: vi.fn(() => false),
      };
    });

    const pi = createMockPi();
    const { default: init } = await import("../index.js");

    expect(() => init(pi as any)).not.toThrow();

    const stash = (globalThis as any).__hashlineToolExecutors;
    const payload = pi.events.emit.mock.calls.find(
      (call: any[]) => call[0] === "hashline:tool-executors"
    )?.[1] as Record<string, any>;

    expect(stash.nu).toBeUndefined();
    expect(payload.nu).toBeUndefined();
  });
});
