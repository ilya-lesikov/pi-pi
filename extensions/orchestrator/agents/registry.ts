import { writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from "fs";
import { join } from "path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

interface AgentFrontmatter {
  description: string;
  tools: string;
  model: string;
  thinking: string;
  max_turns?: number;
  prompt_mode?: string;
}

export function writeAgentFile(
  cwd: string,
  taskId: string,
  agentType: string,
  variant: string | null,
  frontmatter: AgentFrontmatter,
  prompt: string,
): string {
  const agentsDir = join(cwd, ".pi", "agents");
  if (!existsSync(agentsDir)) {
    mkdirSync(agentsDir, { recursive: true });
  }

  const suffix = variant ? `_${variant}` : "";
  const filename = `pp_${taskId}_${agentType}${suffix}.md`;
  const filepath = join(agentsDir, filename);

  const lines = [
    "---",
    `description: ${frontmatter.description}`,
    `tools: ${frontmatter.tools}`,
    `model: ${frontmatter.model}`,
    `thinking: ${frontmatter.thinking}`,
  ];
  if (frontmatter.max_turns !== undefined) {
    lines.push(`max_turns: ${frontmatter.max_turns}`);
  }
  if (frontmatter.prompt_mode) {
    lines.push(`prompt_mode: ${frontmatter.prompt_mode}`);
  }
  lines.push("---", "", prompt);

  writeFileSync(filepath, lines.join("\n"), "utf-8");
  return filename;
}

export function cleanupAgentFiles(cwd: string, taskId: string): void {
  const agentsDir = join(cwd, ".pi", "agents");
  if (!existsSync(agentsDir)) return;

  const prefix = `pp_${taskId}_`;
  for (const file of readdirSync(agentsDir)) {
    if (file.startsWith(prefix)) {
      unlinkSync(join(agentsDir, file));
    }
  }
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
