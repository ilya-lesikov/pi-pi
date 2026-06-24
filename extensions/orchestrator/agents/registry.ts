import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolveModel } from "../model-registry.js";

interface AgentFrontmatter {
  description: string;
  tools: string;
  model: string;
  thinking: string;
  max_turns?: number;
  prompt_mode?: string;
}

export function registerAgentDefinitions(
  pi: ExtensionAPI,
  agents: Array<{ type: string; variant: string | null; frontmatter: AgentFrontmatter; prompt: string }>,
): void {
  const agentMap = new Map<string, any>();

  for (const agent of agents) {
    const suffix = agent.variant ? `_${agent.variant}` : "";
    const name = `${agent.type}${suffix}`;
    const toolNames = agent.frontmatter.tools === "none" ? [] : agent.frontmatter.tools.split(",").map((t: string) => t.trim()).filter(Boolean);

    agentMap.set(name, {
      name,
      description: agent.frontmatter.description,
      builtinToolNames: toolNames,
      extensions: true,
      skills: false,
      model: resolveModel(agent.frontmatter.model),
      thinking: agent.frontmatter.thinking,
      maxTurns: agent.frontmatter.max_turns,
      systemPrompt: agent.prompt,
      promptMode: agent.frontmatter.prompt_mode ?? "replace",
      inheritContext: false,
      runInBackground: true,
      isolated: false,
      enabled: true,
      source: "project",
    });
  }

  pi.events.emit("subagents:register-agents", { agents: agentMap });
}

export function unregisterAgentDefinitions(pi: ExtensionAPI): void {
  pi.events.emit("subagents:unregister-agents", { all: true });
}

export function setExtensionOnlyMode(pi: ExtensionAPI): void {
  pi.events.emit("subagents:set-extension-only", { enabled: true });
}

export function spawnViaRpc(
  pi: ExtensionAPI,
  agentType: string,
  prompt: string,
  options: {
    description: string;
    maxTurns?: number;
    spawnTimeout?: number;
    validateCompletion?: () => string | undefined;
    maxValidationRetries?: number;
  },
): Promise<{ id: string }> {
  const timeout = options.spawnTimeout ?? 30000;
  return new Promise((resolve, reject) => {
    const requestId = crypto.randomUUID();
    const replyEvent = `subagents:rpc:spawn:reply:${requestId}`;

    const unsub = pi.events.on(replyEvent, (reply: any) => {
      unsub();
      if (reply.success) {
        const mgr = (globalThis as any)[Symbol.for("pi-subagents:manager")];
        mgr?.refreshWidget?.();
        resolve({ id: reply.data?.id ?? requestId });
      } else {
        reject(new Error(reply.error || "spawn failed"));
      }
    });

    pi.events.emit("subagents:rpc:spawn", {
      requestId,
      type: agentType,
      prompt,
      options: {
        description: options.description,
        run_in_background: true,
        maxTurns: options.maxTurns,
        validateCompletion: options.validateCompletion,
        maxValidationRetries: options.maxValidationRetries,
      },
    });

    setTimeout(() => {
      unsub();
      reject(new Error(`spawn timeout for ${agentType}`));
    }, timeout);
  });
}

export function waitForCompletion(
  pi: ExtensionAPI,
  agentId: string,
): Promise<{ result: string; status: string }> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearInterval(checkTimer);
      unsubCompleted();
      unsubFailed();
    };

    const unsubCompleted = pi.events.on("subagents:completed", (data: any) => {
      if (data.id === agentId) {
        cleanup();
        resolve({ result: data.result ?? "", status: data.status ?? "completed" });
      }
    });

    const unsubFailed = pi.events.on("subagents:failed", (data: any) => {
      if (data.id === agentId) {
        cleanup();
        reject(new Error(data.error || `agent ${agentId} failed`));
      }
    });

    const checkTimer = setInterval(() => {
      const mgr = (globalThis as any)[Symbol.for("pi-subagents:manager")];
      const record = mgr?.getRecord?.(agentId);
      if (!record) {
        cleanup();
        reject(new Error(`agent ${agentId} not found in manager`));
      }
    }, 30000);
  });
}

export function isSubagentsReady(pi: ExtensionAPI, pingTimeout?: number): Promise<boolean> {
  const timeout = pingTimeout ?? 5000;
  return new Promise((resolve) => {
    const requestId = crypto.randomUUID();
    const replyEvent = `subagents:rpc:ping:reply:${requestId}`;

    const timer = setTimeout(() => {
      unsub();
      resolve(false);
    }, timeout);

    const unsub = pi.events.on(replyEvent, (reply: any) => {
      clearTimeout(timer);
      unsub();
      resolve(reply.success === true);
    });

    pi.events.emit("subagents:rpc:ping", { requestId });
  });
}
