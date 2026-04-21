import { describe, it, expect, vi, afterEach } from "vitest";

async function getWriteTool(fsOverrides?: Partial<typeof import("node:fs")>) {
  vi.resetModules();
  if (fsOverrides) {
    vi.doMock("node:fs", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:fs")>();
      return { ...actual, ...fsOverrides };
    });
  } else {
    vi.doUnmock("node:fs");
  }

  const { registerWriteTool } = await import("../src/write.js");
  let captured: any = null;
  registerWriteTool({ registerTool(def: any) { captured = def; } } as any);
  if (!captured) throw new Error("write tool was not registered");
  return captured;
}

function text(result: any): string {
  return result.content?.find((c: any) => c.type === "text")?.text ?? "";
}

function fsErr(code: string, msg: string): NodeJS.ErrnoException {
  const e: any = new Error(msg);
  e.code = code;
  return e;
}

describe("write fs-error mapping", () => {
  afterEach(() => {
    vi.doUnmock("node:fs");
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it("EACCES on writeFile -> 'Permission denied — cannot write: <path>'", async () => {
    const tool = await getWriteTool({
      mkdirSync: (() => undefined) as any,
      writeFileSync: (() => {
        throw fsErr("EACCES", "EACCES: permission denied, open '/root/locked.txt'");
      }) as any,
    });
    const result = await tool.execute(
      "tc", { path: "/root/locked.txt", content: "hi" },
      new AbortController().signal, undefined, { cwd: process.cwd() },
    );
    expect(result.isError).toBe(true);
    expect(text(result)).toBe("Permission denied — cannot write: /root/locked.txt");
    expect(result.details?.ptcValue?.error?.code).toBe("permission-denied");
  });

  it("EPERM on writeFile -> same permission-denied mapping", async () => {
    const tool = await getWriteTool({
      mkdirSync: (() => undefined) as any,
      writeFileSync: (() => {
        throw fsErr("EPERM", "EPERM: operation not permitted");
      }) as any,
    });
    const result = await tool.execute(
      "tc", { path: "/root/locked2.txt", content: "hi" },
      new AbortController().signal, undefined, { cwd: process.cwd() },
    );
    expect(text(result)).toBe("Permission denied — cannot write: /root/locked2.txt");
    expect(result.details?.ptcValue?.error?.code).toBe("permission-denied");
  });

  it("EISDIR on writeFile -> 'Path is a directory — cannot overwrite: <path>'", async () => {
    const tool = await getWriteTool({
      mkdirSync: (() => undefined) as any,
      writeFileSync: (() => {
        throw fsErr("EISDIR", "EISDIR: illegal operation on a directory");
      }) as any,
    });
    const result = await tool.execute(
      "tc", { path: "/tmp/somedir", content: "hi" },
      new AbortController().signal, undefined, { cwd: process.cwd() },
    );
    expect(text(result)).toBe("Path is a directory — cannot overwrite: /tmp/somedir");
    expect(result.details?.ptcValue?.error?.code).toBe("path-is-directory");
  });

  it("ENOENT on mkdirSync -> 'Cannot create parent directories for <path>: <reason>'", async () => {
    const tool = await getWriteTool({
      mkdirSync: (() => {
        throw fsErr("ENOENT", "ENOENT: parent does not exist");
      }) as any,
    });
    const result = await tool.execute(
      "tc", { path: "/no/such/parent/file.txt", content: "hi" },
      new AbortController().signal, undefined, { cwd: process.cwd() },
    );
    expect(text(result)).toContain("Cannot create parent directories for /no/such/parent/file.txt");
    expect(text(result)).toContain("ENOENT: parent does not exist");
    expect(result.details?.ptcValue?.error?.code).toBe("fs-error");
  });

  it("ENOSPC on writeFile -> 'No space left on device — cannot write: <path>'", async () => {
    const tool = await getWriteTool({
      mkdirSync: (() => undefined) as any,
      writeFileSync: (() => {
        throw fsErr("ENOSPC", "ENOSPC: no space left");
      }) as any,
    });
    const result = await tool.execute(
      "tc", { path: "/tmp/full.txt", content: "hi" },
      new AbortController().signal, undefined, { cwd: process.cwd() },
    );
    expect(text(result)).toBe("No space left on device — cannot write: /tmp/full.txt");
    expect(result.details?.ptcValue?.error?.code).toBe("fs-error");
  });

  it("EROFS on writeFile -> 'Read-only filesystem — cannot write: <path>'", async () => {
    const tool = await getWriteTool({
      mkdirSync: (() => undefined) as any,
      writeFileSync: (() => {
        throw fsErr("EROFS", "EROFS: read-only file system");
      }) as any,
    });
    const result = await tool.execute(
      "tc", { path: "/readonly/file.txt", content: "hi" },
      new AbortController().signal, undefined, { cwd: process.cwd() },
    );
    expect(text(result)).toBe("Read-only filesystem — cannot write: /readonly/file.txt");
    expect(result.details?.ptcValue?.error?.code).toBe("fs-error");
  });

  it("regression: successful write still returns hashlined output", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "write-ok-"));
    try {
      const tool = await getWriteTool();
      const result = await tool.execute(
        "tc", { path: join(dir, "ok.txt"), content: "hello\nworld" },
        new AbortController().signal, undefined, { cwd: process.cwd() },
      );
      expect(result.isError).toBeFalsy();
      expect(text(result)).toMatch(/^1:[0-9a-f]{3}\|hello$/m);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
