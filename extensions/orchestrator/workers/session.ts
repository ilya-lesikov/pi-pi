import { Type } from "@sinclair/typebox";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type AgentSessionEvent,
  type ExtensionAPI,
  type ExtensionFactory,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { registerBashGuard } from "../bash-guard.js";
import type { WorkerFinding, WorkerResult, WorkerSession, WorkerSessionHooks, WorkerSpawnSpec } from "./types.js";

export interface ChildSessionEnv {
  cwd: string;
  /** The root session's model registry; the child shares its runtime and credentials. */
  modelRegistry: () => any;
  systemPrompt: (spec: WorkerSpawnSpec) => string;
  toolNames: (spec: WorkerSpawnSpec) => string[];
  /** Registers pi-pi's own tools and hooks on the child, in place of loading every extension. */
  childExtension: ExtensionFactory;
  /** Default timeout for a child bash call that sets none, in seconds. */
  bashTimeoutSec: () => number;
  /** Whether the root session trusts the project; an untrusted one's settings are not read. */
  projectTrusted: () => boolean;
}

const CHILD_TOOL_NAMES = ["submit_result", "report_progress", "ask_parent"];

export function createChildSessionFactory(env: ChildSessionEnv) {
  return async (spec: WorkerSpawnSpec, hooks: WorkerSessionHooks): Promise<WorkerSession> => {
    const registry = env.modelRegistry();
    const model = findModel(registry, spec.model);
    if (!model) throw new Error(`model ${spec.model} is not available`);
    const agentDir = getAgentDir();
    const settingsManager = SettingsManager.create(env.cwd, agentDir, { projectTrusted: env.projectTrusted() });
    const interrupt = new ToolInterrupt();
    const loader = new DefaultResourceLoader({
      cwd: env.cwd,
      agentDir,
      // Its own would trust the project: an untrusted one's settings would still pick packages to resolve and install.
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      extensionFactories: [
        { name: "pi-pi-worker", hidden: true, factory: env.childExtension },
        { name: "pi-pi-worker-channel", hidden: true, factory: (pi) => registerChildTools(pi, spec, hooks) },
        // Only for roles that have bash: registering it would hand bash to one that has not.
        ...(env.toolNames(spec).includes("bash")
          ? [{ name: "pi-pi-worker-bash", hidden: true, factory: (pi: ExtensionAPI) => registerBashGuard(pi, env.bashTimeoutSec) }]
          : []),
      ],
      systemPromptOverride: () => env.systemPrompt(spec),
      appendSystemPromptOverride: () => [],
    });
    hooks.onPhase("loading worker tools");
    await loader.reload();
    const loadErrors = loader.getExtensions().errors;
    if (loadErrors.length) throw new Error(`worker tools failed to load: ${loadErrors.map((entry: any) => entry.error).join("; ")}`);
    hooks.onPhase("creating the agent session");
    const { session } = await createAgentSession({
      cwd: env.cwd,
      agentDir,
      modelRuntime: registry?.runtime,
      model,
      thinkingLevel: spec.thinking as any,
      tools: [...env.toolNames(spec), ...CHILD_TOOL_NAMES],
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(env.cwd),
      settingsManager,
    });
    session.setSessionName(`${spec.type}: ${spec.description}`);
    interrupt.install(session);
    hooks.onPhase("binding extensions");
    await session.bindExtensions({});
    return new ChildSession(session, hooks, interrupt, registry);
  };
}

function findModel(registry: any, spec: string): any {
  const slash = spec.indexOf("/");
  if (slash < 1) return undefined;
  const provider = spec.slice(0, slash);
  const id = spec.slice(slash + 1);
  return registry?.find?.(provider, id) ?? registry?.getAvailable?.().find((entry: any) => entry.provider === provider && entry.id === id);
}

/**
 * Lets the parent cancel the one tool call a worker is stuck in without ending
 * the worker: every tool runs under its own controller chained to the session's
 * signal, and the wait is raced so a tool that ignores the signal still returns.
 */
class ToolInterrupt {
  private readonly running = new Set<{ controller: AbortController; reject: (error: Error) => void }>();

  install(session: AgentSession): void {
    const tools = (session.agent.state as any).tools as any[];
    const wrap = (tool: any) => {
      if (tool.__piPiInterruptible) return tool;
      const execute = tool.execute;
      return {
        ...tool,
        __piPiInterruptible: true,
        execute: (id: string, params: unknown, signal: AbortSignal | undefined, onUpdate: unknown) => {
          const controller = new AbortController();
          const forward = () => controller.abort();
          signal?.addEventListener("abort", forward, { once: true });
          let entry!: { controller: AbortController; reject: (error: Error) => void };
          return new Promise((resolve, reject) => {
            entry = { controller, reject };
            this.running.add(entry);
            Promise.resolve(execute(id, params, controller.signal, onUpdate)).then(resolve, reject);
          }).finally(() => {
            signal?.removeEventListener("abort", forward);
            this.running.delete(entry);
          });
        },
      };
    };
    // The host rebuilds its active tool list on every registry refresh, so the
    // wrap is reapplied whenever the list is replaced.
    const state = session.agent.state as any;
    let wrapped = tools.map(wrap);
    Object.defineProperty(state, "tools", {
      configurable: true,
      enumerable: true,
      get: () => wrapped,
      set: (next: any[]) => { wrapped = next.map(wrap); },
    });
  }

  interrupt(): boolean {
    const running = [...this.running];
    this.running.clear();
    for (const entry of running) {
      entry.controller.abort();
      entry.reject(new Error("Interrupted by the parent agent. The tool call did not finish; continue without its result."));
    }
    return running.length > 0;
  }
}

const OUTPUT_TAIL_CHARS = 300;

class ChildSession implements WorkerSession {
  private text = "";
  private tail = "";
  private runStart = 0;
  private readonly unsubscribe: () => void;

  constructor(private readonly session: AgentSession, private readonly hooks: WorkerSessionHooks, private readonly interrupt: ToolInterrupt, private readonly registry: any) {
    this.unsubscribe = session.subscribe((event: AgentSessionEvent) => this.onEvent(event));
  }

  private onEvent(event: AgentSessionEvent): void {
    this.hooks.onEvent();
    switch (event.type) {
      case "turn_start":
        this.hooks.onStep("waiting for the model");
        break;
      case "message_start":
        this.text = "";
        break;
      case "message_update":
        this.onStream(event.assistantMessageEvent);
        break;
      case "auto_retry_start":
        this.hooks.onStep(`retrying after a provider error (attempt ${event.attempt}/${event.maxAttempts}): ${event.errorMessage.replace(/\s+/g, " ").slice(0, 120)}`);
        break;
      case "compaction_start":
        this.hooks.onStep("compacting its context");
        break;
      case "message_end": {
        const message: any = event.message;
        this.hooks.onMessage?.(message);
        if (message?.role === "assistant" && message.usage) {
          this.hooks.onUsage({
            input: message.usage.input ?? 0,
            output: message.usage.output ?? 0,
            cacheRead: message.usage.cacheRead ?? 0,
            cacheWrite: message.usage.cacheWrite ?? 0,
            cost: message.usage.cost?.total ?? 0,
          });
        }
        break;
      }
      case "tool_execution_start":
        this.hooks.onToolStart(event.toolName, summarizeArgs(event.toolName, event.args));
        break;
      case "tool_execution_end":
        this.hooks.onToolEnd();
        break;
      case "turn_end":
        this.hooks.onTurnEnd();
        break;
    }
  }

  private onStream(update: any): void {
    switch (update?.type) {
      case "thinking_start":
      case "text_start":
        this.tail = "";
        this.hooks.onStep(update.type === "thinking_start" ? "thinking" : "writing its reply");
        break;
      case "toolcall_start": {
        const name = update.partial?.content?.[update.contentIndex]?.name;
        this.hooks.onStep(`writing a ${name ?? "tool"} call`);
        break;
      }
      case "thinking_delta":
      case "text_delta":
        this.tail = (this.tail + update.delta).slice(-OUTPUT_TAIL_CHARS);
        this.hooks.onOutput(this.tail);
        if (update.type === "text_delta") {
          this.text += update.delta;
          this.hooks.onText(this.text);
        }
        break;
      case "toolcall_delta":
        this.hooks.onOutput();
        break;
    }
  }

  async run(prompt: string): Promise<void> {
    this.runStart = this.session.messages.length;
    await this.session.prompt(prompt, { expandPromptTemplates: false } as any);
  }

  steer(message: string): void {
    void this.session.steer(message).catch(() => {});
  }

  interruptTool(): boolean {
    return this.interrupt.interrupt();
  }

  abort(): void {
    void this.session.abort().catch(() => {});
  }

  dispose(): void {
    this.unsubscribe();
    this.session.dispose();
  }

  async setModel(spec: string): Promise<boolean> {
    const model = findModel(this.registry, spec);
    if (!model) return false;
    await this.session.setModel(model);
    return true;
  }

  lastAssistantText(): string {
    const message = this.terminalAssistant();
    if (!message) return "";
    return (message.content ?? []).filter((part: any) => part.type === "text").map((part: any) => part.text ?? "").join("\n");
  }

  lastError(): string | undefined {
    const message = this.terminalAssistant();
    if (message?.stopReason !== "error") return undefined;
    return message.errorMessage || "The model provider returned an unspecified error.";
  }

  contextPercent(): number | undefined {
    const percent = this.session.getContextUsage()?.percent;
    return typeof percent === "number" ? percent : undefined;
  }

  transcript(): unknown[] {
    return this.session.messages;
  }

  private terminalAssistant(): any {
    const messages = this.session.messages;
    for (let i = messages.length - 1; i >= this.runStart; i--) {
      if ((messages[i] as any)?.role === "assistant") return messages[i];
    }
    return undefined;
  }
}

function summarizeArgs(toolName: string, args: any): string {
  if (!args || typeof args !== "object") return "";
  const value = args.command ?? args.path ?? args.file_path ?? args.filePath ?? args.pattern ?? args.query ?? args.url ?? args.urls?.[0] ?? args.operation;
  const text = typeof value === "string" ? value : value === undefined ? "" : JSON.stringify(value);
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > 80 ? `${line.slice(0, 77)}…` : line;
}

const findingSchema = Type.Object({
  severity: Type.Union([Type.Literal("critical"), Type.Literal("major"), Type.Literal("minor")]),
  location: Type.String({ description: "path:line, a section, or another exact anchor" }),
  issue: Type.String({ description: "What is wrong and why it matters" }),
});

function registerChildTools(pi: ExtensionAPI, spec: WorkerSpawnSpec, hooks: WorkerSessionHooks): void {
  const findings = spec.resultSchema === "findings";
  pi.registerTool({
    name: "submit_result",
    label: "Submit result",
    description: findings
      ? "Deliver your final result to the agent that spawned you: a summary, the full body, and every finding with severity and exact location. Call it once, when done (or when told to stop, with status \"partial\"), then end your turn."
      : "Deliver your final result to the agent that spawned you: a one-line summary and the full body it needs. Call it once, when done (or when told to stop, with status \"partial\"), then end your turn.",
    parameters: Type.Object({
      status: Type.Union([Type.Literal("done"), Type.Literal("partial"), Type.Literal("blocked")]),
      summary: Type.String({ description: "One line: the outcome." }),
      body: Type.String({ description: "Everything the parent needs: findings, evidence with path:line, what you did not check." }),
      ...(findings ? { findings: Type.Array(findingSchema) } : {}),
      open_questions: Type.Optional(Type.Array(Type.String())),
    }) as any,
    async execute(_id: string, params: any) {
      const result: WorkerResult = {
        status: params.status,
        summary: String(params.summary ?? ""),
        body: String(params.body ?? ""),
        ...(Array.isArray(params.findings) ? { findings: params.findings as WorkerFinding[] } : {}),
        ...(Array.isArray(params.open_questions) && params.open_questions.length ? { openQuestions: params.open_questions } : {}),
      };
      hooks.submitResult(result);
      return { content: [{ type: "text" as const, text: "Result delivered. End your turn now." }], details: undefined, terminate: true };
    },
  } as ToolDefinition<any, any>);
  pi.registerTool({
    name: "report_progress",
    label: "Report progress",
    description: "Show a one-line progress note to the user. Does not reach the parent agent and does not wait. Use it at milestones of long work.",
    parameters: Type.Object({ text: Type.String() }),
    async execute(_id: string, params: any) {
      hooks.reportProgress(String(params.text ?? "").slice(0, 300));
      return { content: [{ type: "text" as const, text: "Noted." }], details: undefined };
    },
  } as ToolDefinition<any, any>);
  pi.registerTool({
    name: "ask_parent",
    label: "Ask parent",
    description: "Ask the agent that spawned you a question you cannot settle yourself, and wait for its answer. Only for a decision that changes the work; otherwise proceed under the safest reversible reading and say so in your result. Returns the answer, or a note that none came.",
    parameters: Type.Object({ question: Type.String() }),
    async execute(_id: string, params: any, signal?: AbortSignal) {
      const answer = await hooks.askParent(String(params.question ?? ""), signal);
      const text = answer === undefined
        ? "No answer came. Proceed under the safest reversible reading and record the assumption in your result."
        : `Answer from your parent: ${answer}`;
      return { content: [{ type: "text" as const, text }], details: undefined };
    },
  } as ToolDefinition<any, any>);
}
