import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Orchestrator } from "./orchestrator.js";
import { registerCommandHandlers } from "./command-handlers.js";
import { registerEventHandlers } from "./event-handlers.js";
import { registerCbmTools } from "./cbm.js";
import { registerExaTools } from "./exa.js";
import { registerAstSearchTool } from "./ast-search.js";
import { validatePlan, validateArtifact } from "./validate-artifacts.js";

const ORCHESTRATOR_KEY = Symbol.for("pi-pi:orchestrator-initialized");
export const SUBAGENT_SESSION_KEY = Symbol.for("pi-pi:subagent-session");

export default function (pi: ExtensionAPI) {
  if ((globalThis as any)[ORCHESTRATOR_KEY]) {
    (globalThis as any)[SUBAGENT_SESSION_KEY] = true;
    registerSubagentTools(pi);
    return;
  }
  (globalThis as any)[ORCHESTRATOR_KEY] = true;

  const orchestrator = new Orchestrator(pi);
  registerEventHandlers(orchestrator);
  registerCommandHandlers(orchestrator);
}

function registerSubagentTools(pi: ExtensionAPI): void {
  const cwd = process.cwd();
  registerCbmTools(pi, cwd);
  registerExaTools(pi);
  registerAstSearchTool(pi, cwd);

  pi.on("tool_result", async (event) => {
    if ((event.toolName !== "write" && event.toolName !== "edit") || event.isError) return;

    const input = event.input as { file_path?: string; filePath?: string; path?: string };
    const filePath = input.file_path || input.filePath || input.path;
    if (!filePath) return;

    const resolved = resolve(cwd, filePath);
    if (!resolved.endsWith(".md")) return;
    if (!existsSync(resolved)) return;

    if (resolved.includes("/plans/") && !resolved.includes("synthesized") && !resolved.includes("review_")) {
      const content = readFileSync(resolved, "utf-8");
      const result = validatePlan(content);
      if (!result.ok) {
        return {
          content: [
            ...event.content,
            {
              type: "text" as const,
              text: `\n\n<validation-error>\nPlan structure is invalid:\n${result.errors.map((e) => `- ${e}`).join("\n")}\n\nFix immediately. Required structure:\n# Plan\n## Scope\n<2-4 lines>\n## Checklist\n- [ ] <outcome> — Done when: <observable condition>\n## Blockers (optional)\n<issues>\n\nRewrite the file now.\n</validation-error>`,
            },
          ],
        };
      }
    }

    if (resolved.includes("/artifacts/")) {
      const content = readFileSync(resolved, "utf-8");
      const result = validateArtifact(content);
      if (!result.ok) {
        return {
          content: [
            ...event.content,
            {
              type: "text" as const,
              text: `\n\n<validation-error>\nArtifact structure is invalid:\n${result.errors.map((e) => `- ${e}`).join("\n")}\n\nFix immediately. Artifact files must start with # <Title>.\n</validation-error>`,
            },
          ],
        };
      }
    }
  });
}
