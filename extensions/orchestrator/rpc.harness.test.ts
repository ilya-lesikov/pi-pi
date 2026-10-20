import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { afterEach, describe, expect, it } from "vitest";

/**
 * Runs the real pi CLI in RPC and print mode with pi-pi loaded and a
 * scripted model, and plays a host against it: the conformance check that
 * pi-pi's dialogs, reports and notices reach a host the way the host-facing
 * code assumes. Each host profile answers dialogs the way that host does.
 */
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const PI = join(root, "node_modules", ".bin", "pi");
const FAKE = join(here, "fixtures", "rpc", "fake-provider.ts");

type Request = { id: string; method: string; title?: string; options?: string[]; placeholder?: string; message?: string; prefill?: string };
type Profile = (request: Request) => unknown | undefined;

interface Run {
  events: any[];
  dialogs: Request[];
  send(command: Record<string, unknown>): void;
  waitFor(predicate: (event: any) => boolean, timeoutMs?: number): Promise<any>;
  close(): Promise<void>;
  modelSaw(): any[][];
}

const cleanup: Array<() => void> = [];
afterEach(async () => {
  while (cleanup.length) cleanup.pop()!();
});

function sandbox(): { agent: string; project: string; log: string } {
  const agent = mkdtempSync(join(tmpdir(), "pp-rpc-agent-"));
  const project = mkdtempSync(join(tmpdir(), "pp-rpc-project-"));
  cleanup.push(() => { rmSync(agent, { recursive: true, force: true }); rmSync(project, { recursive: true, force: true }); });
  return { agent, project, log: join(project, "model.log") };
}

function start(steps: unknown[], profile: Profile, env: Record<string, string> = {}, model: string[] = ["--provider", "pp-fake", "--model", "scripted"]): Run {
  const { agent, project, log } = sandbox();
  const child: ChildProcessWithoutNullStreams = spawn(PI, ["--mode", "rpc", "--no-session", "--no-extensions", "-e", join(root, "extensions", "orchestrator", "index.ts"), "-e", FAKE, ...model], {
    cwd: project,
    env: { ...process.env, PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1", PP_FAKE_SCRIPT: JSON.stringify(steps), PP_FAKE_LOG: log, BB_THREAD_ID: "", PASEO_AGENT_ID: "", T3_PI_RUNTIME_MODE: "", ...env },
  });
  cleanup.push(() => child.kill("SIGKILL"));
  const events: any[] = [];
  const dialogs: Request[] = [];
  const waiters = new Set<() => void>();
  const send = (command: Record<string, unknown>) => child.stdin.write(`${JSON.stringify(command)}\n`);
  createInterface({ input: child.stdout }).on("line", (line) => {
    let event: any;
    try { event = JSON.parse(line); } catch { return; }
    events.push(event);
    if (event.type === "extension_ui_request" && ["select", "confirm", "input", "editor"].includes(event.method)) {
      dialogs.push(event);
      const answer = profile(event);
      send({ type: "extension_ui_response", id: event.id, ...(answer === undefined ? { cancelled: true } : event.method === "confirm" ? { confirmed: answer } : { value: answer }) });
    }
    for (const wake of waiters) wake();
  });
  return {
    events,
    dialogs,
    send,
    waitFor(predicate, timeoutMs = 20_000) {
      return new Promise((resolve, reject) => {
        const found = () => events.find(predicate);
        const hit = found();
        if (hit) return resolve(hit);
        const timer = setTimeout(() => { waiters.delete(check); reject(new Error(`timed out; events: ${events.map((e) => e.type + (e.method ? `:${e.method}` : "")).join(" ")}`)); }, timeoutMs);
        const check = () => {
          const event = found();
          if (!event) return;
          clearTimeout(timer);
          waiters.delete(check);
          resolve(event);
        };
        waiters.add(check);
      });
    },
    async close() {
      child.stdin.end();
      await new Promise((resolve) => { child.once("exit", resolve); setTimeout(resolve, 3000); });
    },
    modelSaw: () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : []),
  };
}

const toolResult = (run: Run, name: string) => run.waitFor((event) => event.type === "tool_execution_end" && event.toolName === name);
const resultText = (event: any) => (event.result?.content ?? []).map((part: any) => part.text ?? "").join("");
const settled = (run: Run) => run.waitFor((event) => event.type === "agent_settled");

// A host that shows every dialog to a person who picks deliberately.
const person = (answers: Record<string, (request: Request) => unknown>): Profile => (request) => answers[request.method]?.(request);

describe.skipIf(!existsSync(PI))("pi-pi over pi's RPC mode", { timeout: 60_000 }, () => {
  it("starts on the model pi was given, even one only an extension provides", async () => {
    const run = start([{ text: "hi" }], () => undefined, {}, ["--model", "pp-fake/scripted", "--thinking", "low"]);
    // pi resolved --model before the extension registered the provider; pi-pi applies it once it exists.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    run.send({ id: "state", type: "get_state" });
    const after = await run.waitFor((event) => event.type === "response" && event.id === "state");
    expect(after.data.model).toMatchObject({ provider: "pp-fake", id: "scripted" });
    expect(after.data.thinkingLevel).toBe("low");
    await run.close();
  });

  it("asks a single-choice question as one bounded select and gets the answer by label", async () => {
    const run = start([{ tool: "ask_user", args: { question: "Which strategy for the payments service?", options: ["Rolling", { title: "Blue/green", description: "instant rollback" }], recommended: "Blue/green" } }, { text: "ok" }], person({ select: (r) => r.options![1] }));
    run.send({ type: "prompt", message: "go" });
    const end = await toolResult(run, "ask_user");
    expect(resultText(end)).toBe("User answered: Blue/green");
    expect(run.dialogs).toHaveLength(1);
    expect(run.dialogs[0]).toMatchObject({ method: "select", title: "Which strategy for the payments service?", options: ["Rolling", "Blue/green (recommended) — instant rollback", "Other…"] });
    for (const dialog of run.dialogs) {
      expect(dialog.title!.length).toBeLessThanOrEqual(200);
      expect(dialog.title).not.toContain("\n");
    }
    await settled(run);
    await run.close();
  });

  it("on a host that cancels typed text instantly, stops offering it and tells the model to ask in prose", async () => {
    const run = start([{ tool: "ask_user", args: { question: "Pick", options: ["A", "B"] } }, { tool: "ask_user", args: { question: "Name?" } }, { text: "ok" }], (request) => {
      if (request.method === "select") return request.options!.includes("Other…") ? "Other…" : undefined;
      return undefined;
    });
    run.send({ type: "prompt", message: "go" });
    await settled(run);
    const ends = run.events.filter((event) => event.type === "tool_execution_end" && event.toolName === "ask_user");
    expect(ends).toHaveLength(2);
    expect(run.dialogs.map((d) => d.method)).toEqual(["select", "input", "select", "input"]);
    expect(run.dialogs[2]!.options).toEqual(["A", "B"]);
    expect(resultText(ends[1])).toMatch(/cannot collect typed answers/);
    await run.close();
  });

  it("asks confirm as the host's native yes/no with the question in the title", async () => {
    const run = start([{ tool: "confirm", args: { question: "Delete 3 stale namespaces?", detail: "recreated on next PR", danger: true } }, { text: "ok" }], person({ confirm: () => true }));
    run.send({ type: "prompt", message: "go" });
    const end = await toolResult(run, "confirm");
    expect(resultText(end)).toBe("User confirmed: yes.");
    expect(run.dialogs[0]).toMatchObject({ method: "confirm", title: "Delete 3 stale namespaces?" });
    expect(run.dialogs[0]!.message).toMatch(/^recreated on next PR\n⚠ Destructive · request /);
    await settled(run);
    await run.close();
  });

  it("opens /pp on bb with the warning in the menu, the report in a text dialog, and neither in the model's context", async () => {
    let step = 0;
    const run = start([{ text: "first" }, { text: "second" }], (request) => {
      if (request.method === "editor") return request.prefill;
      if (request.method !== "select") return undefined;
      step++;
      return request.options!.find((option) => option.startsWith(step === 1 ? "Status" : "Close"));
    }, { BB_THREAD_ID: "thread-1" });
    run.send({ type: "prompt", message: "hello" });
    await settled(run);
    run.send({ type: "prompt", message: "/pp" });
    await run.waitFor(() => step >= 2);
    // bb drops notify and shows chat messages only inside a turn, which /pp
    // does not open: what it does show are dialogs.
    const menu = run.dialogs[0]!;
    expect(menu.method).toBe("select");
    expect(menu.title).toMatch(/^\/pp · session control panel \(press Stop afterwards if the app stays busy\)$/);
    expect(menu.options![0]).toMatch(/^Status — /);
    const reportDialog = run.dialogs.find((dialog) => dialog.method === "editor")!;
    expect(reportDialog.title).toMatch(/^pi-pi · status/);
    expect(reportDialog.prefill).toMatch(/^Model: /);
    run.send({ type: "prompt", message: "again" });
    await run.waitFor((event) => event.type === "agent_settled" && run.events.filter((e) => e.type === "agent_settled").length >= 2);
    const lastRequest = run.modelSaw().at(-1)!;
    // pi hands custom messages to the model as user messages, so match on what they say.
    expect(lastRequest.some((message: any) => message.content?.[0]?.text === "again")).toBe(true);
    expect(JSON.stringify(lastRequest)).not.toContain("pi-pi · status");
    expect(JSON.stringify(lastRequest)).not.toContain("may stay busy");
    await run.close();
  });

  it("puts /pp reports in the chat and keeps them from the model on a host that shows chat messages", async () => {
    let step = 0;
    const run = start([{ text: "first" }, { text: "second" }], (request) => {
      if (request.method !== "select") return undefined;
      step++;
      return request.options!.find((option) => option.startsWith(step === 1 ? "Status" : "Close"));
    });
    run.send({ type: "prompt", message: "hello" });
    await settled(run);
    run.send({ type: "prompt", message: "/pp" });
    const reportMessage = await run.waitFor((event) => event.type === "message_end" && event.message?.customType === "pp-report");
    expect(JSON.stringify(reportMessage.message.content)).toContain("pi-pi · status");
    await run.waitFor(() => step >= 2);
    run.send({ type: "prompt", message: "again" });
    await run.waitFor((event) => event.type === "agent_settled" && run.events.filter((e) => e.type === "agent_settled").length >= 2);
    const lastRequest = run.modelSaw().at(-1)!;
    expect(lastRequest.some((message: any) => message.content?.[0]?.text === "again")).toBe(true);
    expect(JSON.stringify(lastRequest)).not.toContain("pi-pi · status");
    await run.close();
  });
});

describe.skipIf(!existsSync(PI))("pi-pi in print mode", { timeout: 60_000 }, () => {
  it("lets the model proceed on stated assumptions when nobody can answer", async () => {
    const { agent, project, log } = sandbox();
    const steps = [{ tool: "ask_user", args: { question: "Which db?", options: ["Postgres", "SQLite"], recommended: "SQLite" } }, { text: "picked SQLite" }];
    const output = await new Promise<{ stdout: string; stderr: string }>((resolve) => {
      const child = spawn(PI, ["-p", "--no-session", "--no-extensions", "-e", join(root, "extensions", "orchestrator", "index.ts"), "-e", FAKE, "--provider", "pp-fake", "--model", "scripted", "go"], {
        cwd: project,
        env: { ...process.env, PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1", PP_FAKE_SCRIPT: JSON.stringify(steps), PP_FAKE_LOG: log },
      });
      // pi reads a piped stdin as part of the prompt; there is none.
      child.stdin.end();
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.stderr.on("data", (chunk) => (stderr += chunk));
      child.on("exit", () => resolve({ stdout, stderr }));
      setTimeout(() => child.kill("SIGKILL"), 40_000);
    });
    expect(output.stdout.trim()).toBe("picked SQLite");
    // pi-pi's notices never end up in the printed answer.
    expect(output.stdout).not.toContain("pi-pi: ");
    const sent = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line)).at(-1)!;
    const toolMessage = sent.find((message: any) => message.role === "toolResult" && message.toolName === "ask_user");
    expect(toolMessage.isError).toBe(false);
    expect(toolMessage.content[0].text).toContain("Take the recommended option for each");
  });
});
