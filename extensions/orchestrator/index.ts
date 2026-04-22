import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Orchestrator } from "./orchestrator.js";
import { registerCommandHandlers } from "./command-handlers.js";
import { registerEventHandlers } from "./event-handlers.js";

export default function (pi: ExtensionAPI) {
  const orchestrator = new Orchestrator(pi);
  registerEventHandlers(orchestrator);
  registerCommandHandlers(orchestrator);
}
