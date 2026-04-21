import { describe, it, expect, vi, afterEach } from "vitest";
import { EventEmitter } from "node:events";

afterEach(() => {
  vi.resetModules();
  vi.doUnmock("node:child_process");
});

function mockNuRun(result: { stdout?: string; stderr?: string; exitCode: number | null }) {
  vi.doMock("node:child_process", async () => {
    const actual = await vi.importActual<any>("node:child_process");
    return {
      ...actual,
      execFileSync: vi.fn(() => Buffer.from("0.111.0\n")),
      spawn: vi.fn(() => {
        const proc = new EventEmitter() as any;
        proc.stdout = new EventEmitter();
        proc.stderr = new EventEmitter();
        proc.kill = vi.fn();

        queueMicrotask(() => {
          if (result.stdout) proc.stdout.emit("data", Buffer.from(result.stdout));
          if (result.stderr) proc.stderr.emit("data", Buffer.from(result.stderr));
          proc.emit("close", result.exitCode);
        });

        return proc;
      }),
    };
  });
}

describe("nu tool execute() integrates augmentNuOutput", () => {
  it("appends [nu-hint] to the returned text when executeNuScript fails with a matching needle", async () => {
    vi.resetModules();
    mockNuRun({
      stderr: "nu error:\ncommand not found: gstat\n",
      exitCode: 1,
    });

    const { registerNuTool, NU_ERROR_HINTS } = await import("../src/nu.js");
    const pi: any = { registerTool: vi.fn() };
    const tool = registerNuTool(pi);
    if (!tool) throw new Error("expected tool registration to succeed");

    const result = await tool.execute(
      "call-1",
      { command: "gstat" },
      undefined,
      undefined,
      { cwd: process.cwd() } as any,
    );

    const text = (result.content[0] as { type: "text"; text: string }).text;
    expect(text).toContain("command not found: gstat");
    const gstatHint = NU_ERROR_HINTS["command not found: gstat"];
    expect(text).toContain(`\n\n[nu-hint] ${gstatHint}`);
  });

  it("does not append any [nu-hint] when executeNuScript succeeds", async () => {
    vi.resetModules();
    mockNuRun({
      stdout: "all good; mentions command not found: gstat in docs\n",
      exitCode: 0,
    });

    const { registerNuTool } = await import("../src/nu.js");
    const pi: any = { registerTool: vi.fn() };
    const tool = registerNuTool(pi);
    if (!tool) throw new Error("expected tool registration to succeed");

    const result = await tool.execute(
      "call-2",
      { command: "echo hi" },
      undefined,
      undefined,
      { cwd: process.cwd() } as any,
    );

    const text = (result.content[0] as { type: "text"; text: string }).text;
    expect(text).not.toContain("[nu-hint]");
    expect(text).toBe("all good; mentions command not found: gstat in docs");
  });
});

describe("NU_GUIDELINES / prompt surfaces remain free of hint content", () => {
  it("does not inject NU_ERROR_HINTS keys into NU_GUIDELINES", async () => {
    const { NU_GUIDELINES, NU_ERROR_HINTS } = await import("../src/nu.js");
    const serialized = NU_GUIDELINES.join("\n\n");
    for (const needle of Object.keys(NU_ERROR_HINTS)) {
      expect(serialized).not.toContain(needle);
    }
    expect(serialized).not.toContain("[nu-hint]");
  });
});
