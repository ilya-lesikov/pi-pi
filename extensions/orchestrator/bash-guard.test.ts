import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { bashOwnedElsewhere, keepBashOffWhereItWas, registerBashGuard } from "./bash-guard.js";
import { parseToolNames, toolsBlock } from "./agents/tool-routing.js";

// Real commands through pi's own bash, with limits short enough for a test.
function bash(limits: { timeoutSec?: number; silenceMs?: number }) {
  let tool: any;
  const pi: any = { registerTool: (definition: any) => { tool = definition; }, on: () => {} };
  registerBashGuard(pi, process.cwd(), { timeoutSec: () => limits.timeoutSec ?? 0, silenceMs: () => limits.silenceMs ?? 0 }, { settings: SettingsManager.inMemory() });
  const run = (params: { command: string; timeout?: number }, signal?: AbortSignal) =>
    tool.execute("call", params, signal, () => {}, undefined).then(
      (result: any) => ({ ok: true, text: result.content.map((part: any) => part.text).join("") }),
      (error: Error) => ({ ok: false, text: error.message }),
    );
  return { tool, run };
}

describe("bash guard", () => {
  it("stops a command that prints nothing for the silence limit, keeping what it printed", async () => {
    const { run } = bash({ silenceMs: 1000 });
    const started = Date.now();
    const result = await run({ command: "echo started; sleep 30" });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(result.ok).toBe(false);
    expect(result.text).toMatch(/^started\n\nCommand stopped: it printed nothing for 1 s, and was killed/);
    expect(result.text).toContain("rerun it with an explicit `timeout`");
  });

  it("never waits less than a second, since pi reports output only every 100ms", async () => {
    const { run } = bash({ silenceMs: 50 });
    expect(await run({ command: "for i in 1 2 3; do echo $i; sleep 0.25; done" })).toEqual({ ok: true, text: "1\n2\n3\n" });
  });

  it("lets a command run past the silence limit while it keeps printing", async () => {
    const { run } = bash({ silenceMs: 700 });
    const result = await run({ command: "for i in 1 2 3 4 5; do echo $i; sleep 0.3; done" });
    expect(result).toEqual({ ok: true, text: "1\n2\n3\n4\n5\n" });
  });

  it("leaves a call with its own timeout alone: no silence stop, its timeout wins", async () => {
    const { run } = bash({ silenceMs: 300, timeoutSec: 1 });
    expect(await run({ command: "sleep 1.2; echo done", timeout: 5 })).toEqual({ ok: true, text: "done\n" });
    const timedOut = await run({ command: "sleep 30", timeout: 1 });
    expect(timedOut.text).toMatch(/Command timed out after 1 seconds/);
    expect((await run({ command: "echo hi", timeout: 0 })).text).toMatch(/Invalid timeout/);
  });

  it("gives a call without a timeout the default one", async () => {
    const { run } = bash({ timeoutSec: 1 });
    const result = await run({ command: "echo hi; sleep 30" });
    expect(result.ok).toBe(false);
    expect(result.text).toMatch(/^hi\n+Command timed out after 1 seconds$/);
  });

  it("reports a user's abort as an abort, not as silence", async () => {
    const { run } = bash({ silenceMs: 60_000 });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 300);
    const result = await run({ command: "sleep 30" }, controller.signal);
    expect(result.text).toMatch(/Command aborted$/);
  });

  it("tells an agent with bash, and only one, how to run commands that do not exit", () => {
    const withBash = toolsBlock(parseToolNames("read, bash"));
    expect(withBash).toMatch(/in a bash call of its own, in the background/);
    expect(withBash).toMatch(/set bash's `timeout` on any command that can take more than a few seconds/);
    expect(toolsBlock(parseToolNames("read, grep"))).not.toMatch(/bash's `timeout`/);
  });

  it("reads the shell command prefix of the session's project, and only while that project is trusted", async () => {
    const root = mkdtempSync(join(tmpdir(), "pp-guard-"));
    try {
      const project = join(root, "project");
      mkdirSync(join(project, ".pi"), { recursive: true });
      mkdirSync(join(root, "agent"));
      writeFileSync(join(project, ".pi", "settings.json"), JSON.stringify({ shellCommandPrefix: "echo INJECTED" }));
      let tool: any;
      let sessionStart: () => Promise<void> = async () => {};
      // Registered for another directory, as at load: the session's own is what counts.
      registerBashGuard({ registerTool: (definition: any) => { tool = definition; }, on: (_event: string, handler: any) => { sessionStart = handler; } } as any, root, { timeoutSec: () => 0, silenceMs: () => 0 }, { agentDir: join(root, "agent") });
      const output = async (trusted: boolean) => {
        const result = await tool.execute("call", { command: "echo ok" }, undefined, () => {}, { cwd: project, isProjectTrusted: () => trusted, sessionManager: { getSessionId: () => "s", getSessionFile: () => undefined } });
        return result.content.map((part: any) => part.text).join("");
      };
      expect(await output(false)).toBe("ok\n");
      expect(await output(true)).toBe("INJECTED\nok\n");
      // Read once per session: a change shows only after the next session starts.
      writeFileSync(join(project, ".pi", "settings.json"), JSON.stringify({ shellCommandPrefix: "echo CHANGED" }));
      expect(await output(true)).toBe("INJECTED\nok\n");
      await sessionStart();
      expect(await output(true)).toBe("CHANGED\nok\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("names the extension whose bash wins over pi-pi's, and stays quiet when pi-pi's is in place", () => {
    const owner = (path: string, source = "local") => bashOwnedElsewhere({ getAllTools: () => [{ name: "bash", sourceInfo: { path, source } }] } as any);
    // pi-pi's own registration comes from its package directory, whatever tools the session allows.
    expect(owner(join(process.cwd(), "extensions", "orchestrator", "index.ts"))).toBeNull();
    expect(owner("<builtin:bash>", "builtin")).toBeNull();
    expect(owner("/elsewhere/pi-tool-display/index.ts")).toBe("/elsewhere/pi-tool-display/index.ts");
    // Installed through a symlink: pi reports the link, the module sits at the target.
    const root = mkdtempSync(join(tmpdir(), "pp-guard-link-"));
    try {
      symlinkSync(process.cwd(), join(root, "pi-pi"));
      expect(owner(join(root, "pi-pi", "extensions", "orchestrator", "index.ts"))).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps bash as it was across a reload, rather than as pi started", () => {
    let active = ["read", "bash"];
    const pi = { getActiveTools: () => active, setActiveTools: (next: string[]) => { active = next; } } as any;
    // Started with -nbt, then turned on by the user: a reload keeps it on.
    keepBashOffWhereItWas(pi, ["-nbt"], undefined, true);
    expect(active).toContain("bash");
    // Off before the reload: off after it, though pi turned it on again.
    keepBashOffWhereItWas(pi, [], undefined, false);
    expect(active).not.toContain("bash");
  });

  it("turns bash back off where pi's own rules leave it off, and nowhere else", () => {
    const cases: Array<[string[], string[] | undefined, boolean]> = [
      [["--no-builtin-tools"], undefined, false],
      [["-nbt"], undefined, false],
      [["--no-tools"], undefined, false],
      [[], ["read", "grep"], false],
      [["--exclude-tools", "bash"], undefined, false],
      [["--tools", "read,bash"], ["read"], true],
      // --tools wins over -nbt, and the last --tools counts, as in pi.
      [["-nbt", "--tools", "bash"], undefined, true],
      [["--tools", "read", "--tools", "bash"], ["read"], true],
      // Past `--` it is a message, not a flag.
      [["--", "--no-builtin-tools"], undefined, true],
      [[], undefined, true],
      [[], ["read", "bash"], true],
    ];
    for (const [argv, defaults, kept] of cases) {
      let active = ["read", "bash", "lsp"];
      keepBashOffWhereItWas({ getActiveTools: () => active, setActiveTools: (next: string[]) => { active = next; } } as any, argv, defaults);
      expect([argv.join(" "), active.includes("bash")]).toEqual([argv.join(" "), kept]);
      expect(active).toContain("lsp");
    }
  });
});
