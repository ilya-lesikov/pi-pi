import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";

// Check if nu is installed for integration tests
const nuAvailable = (() => {
  try {
    execFileSync("nu", ["--version"], { timeout: 3000, stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
})();

const describeNu = nuAvailable ? describe : describe.skip;

describeNu("executeNuScript (integration)", () => {
  it("executes a simple expression and returns result", async () => {
    const { executeNuScript } = await import("../src/nu.js");
    const result = await executeNuScript({
      command: "[1 2 3] | math sum",
      cwd: process.cwd(),
    });
    expect(result.output.trim()).toBe("6");
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
  });

  it("captures stderr on error command", async () => {
    const { executeNuScript } = await import("../src/nu.js");
    const result = await executeNuScript({
      command: "nonexistent_command_xyz_123",
      cwd: process.cwd(),
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.output.toLowerCase()).toMatch(/not found|not_found|error|external/i);
  });

  it("respects timeout", async () => {
    const { executeNuScript } = await import("../src/nu.js");
    const result = await executeNuScript({
      command: "sleep 10sec",
      cwd: process.cwd(),
      timeoutSeconds: 1,
    });
    expect(result.timedOut).toBe(true);
    expect(result.output).toContain("timed out");
  });

  it("cleans up temp files after execution", async () => {
    const { executeNuScript } = await import("../src/nu.js");
    await executeNuScript({ command: "echo hello", cwd: process.cwd() });
    const tmpFiles = readdirSync(tmpdir()).filter(
      (f: string) => f.startsWith("pi-nu-") && f.endsWith(".nu"),
    );
    expect(tmpFiles.length).toBe(0);
  });

  it("strips ANSI codes from output", async () => {
    const { executeNuScript } = await import("../src/nu.js");
    const result = await executeNuScript({
      command: 'echo "hello"',
      cwd: process.cwd(),
    });
    expect(result.output).not.toMatch(/\x1b\[/);
  });

  it("handles multi-line scripts", async () => {
    const { executeNuScript } = await import("../src/nu.js");
    const result = await executeNuScript({
      command: "let x = 5\nlet y = 10\n$x + $y",
      cwd: process.cwd(),
    });
    expect(result.output.trim()).toBe("15");
  });
});

describe("executeNuScript (error handling)", () => {
  it("short-circuits when signal is already aborted", async () => {
    const { executeNuScript } = await import("../src/nu.js");
    const controller = new AbortController();
    controller.abort();
    const result = await executeNuScript({
      command: "echo should-not-run",
      cwd: process.cwd(),
      signal: controller.signal,
    });
    expect(result.output).toContain("aborted");
    expect(result.exitCode).toBe(-1);
  });

  it("returns error for spawn failure with invalid binary", async () => {
    // Temporarily test with a deliberately broken PATH to verify ENOENT handling
    const { executeNuScript } = await import("../src/nu.js");
    // We can't easily force ENOENT without mocking, but we verify the function
    // handles the error event path by checking the contract
    const result = await executeNuScript({
      command: "echo test",
      cwd: "/nonexistent-directory-xyz-12345",
    });
    // spawn with invalid cwd should produce an error
    expect(result.exitCode).toBe(-1);
    expect(result.output.length).toBeGreaterThan(0);
  });

  it("returns structured result shape on all paths", async () => {
    const { executeNuScript } = await import("../src/nu.js");
    const controller = new AbortController();
    controller.abort();
    const result = await executeNuScript({
      command: "echo test",
      cwd: process.cwd(),
      signal: controller.signal,
    });
    // Verify the result always has the expected shape
    expect(result).toHaveProperty("output");
    expect(result).toHaveProperty("exitCode");
    expect(result).toHaveProperty("timedOut");
    expect(typeof result.output).toBe("string");
    expect(typeof result.timedOut).toBe("boolean");
  });
});
