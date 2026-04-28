import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Orchestrator } from "./orchestrator.js";
import { registerCommandHandlers } from "./command-handlers.js";
import { registerEventHandlers } from "./event-handlers.js";

const ORCHESTRATOR_KEY = Symbol.for("pi-pi:orchestrator-initialized");

export default function (pi: ExtensionAPI) {
  if ((globalThis as any)[ORCHESTRATOR_KEY]) return;
  (globalThis as any)[ORCHESTRATOR_KEY] = true;

  const orchestrator = new Orchestrator(pi);
  registerEventHandlers(orchestrator);
  registerCommandHandlers(orchestrator);
}
