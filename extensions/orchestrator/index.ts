import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Orchestrator } from "./orchestrator.js";
import { registerCommandHandlers } from "./command-handlers.js";
import { registerEventHandlers } from "./event-handlers.js";
import { registerCbmTools } from "./cbm.js";
import { registerExaTools } from "./exa.js";
import { registerAstSearchTool } from "./ast-search.js";

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
}
