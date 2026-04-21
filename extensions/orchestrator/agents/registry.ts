import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

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
  taskId: string,
  agents: Array<{ type: string; variant: string | null; frontmatter: AgentFrontmatter; prompt: string }>,
): void {
  const agentMap = new Map<string, any>();

  for (const agent of agents) {
    const suffix = agent.variant ? `_${agent.variant}` : "";
    const name = `pp_${taskId}_${agent.type}${suffix}`;
    const toolNames = agent.frontmatter.tools === "none" ? [] : agent.frontmatter.tools.split(",").map((t: string) => t.trim()).filter(Boolean);

    agentMap.set(name, {
      name,
      description: agent.frontmatter.description,
      builtinToolNames: toolNames,
      extensions: true,
      skills: true,
      model: agent.frontmatter.model,
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

export function unregisterAgentDefinitions(pi: ExtensionAPI, taskId: string): void {
  pi.events.emit("subagents:unregister-agents", { prefix: `pp_${taskId}_` });
}

export function disableDefaultAgents(pi: ExtensionAPI): void {
  const defaults = new Map<string, any>();
  for (const name of ["general-purpose", "Explore", "Plan"]) {
    defaults.set(name, {
      name,
      description: "",
      builtinToolNames: [],
      extensions: false,
      skills: false,
      systemPrompt: "",
      promptMode: "replace",
      enabled: false,
      isDefault: true,
    });
  }
  pi.events.emit("subagents:register-agents", { agents: defaults });
}

export function spawnViaRpc(
  pi: ExtensionAPI,
  agentType: string,
  prompt: string,
  options: { description: string; model?: string; maxTurns?: number; thinkingLevel?: string; spawnTimeout?: number },
): Promise<{ id: string }> {
  const timeout = options.spawnTimeout ?? 30000;
  return new Promise((resolve, reject) => {
    const requestId = crypto.randomUUID();
    const replyEvent = `subagents:rpc:spawn:reply:${requestId}`;

    const unsub = pi.events.on(replyEvent, (reply: any) => {
      unsub();
      if (reply.success) {
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
        model: options.model,
        maxTurns: options.maxTurns,
        thinkingLevel: options.thinkingLevel,
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
  completionTimeout?: number,
): Promise<{ result: string; status: string }> {
  const timeout = completionTimeout ?? 600000;
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
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

    const timer = setTimeout(() => {
      unsubCompleted();
      unsubFailed();
      reject(new Error(`agent ${agentId} timed out after ${timeout}ms`));
    }, timeout);
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
