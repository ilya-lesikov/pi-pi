import type { Orchestrator } from "./orchestrator.js";
import { asCommand } from "./notices.js";

export function registerCommandHandlers(orchestrator: Orchestrator): void {
  orchestrator.pi.registerCommand("pp", {
    description: "Open the pi-pi control panel",
    handler: async (_args, ctx) => {
      orchestrator.lastCtx = ctx;
      const { showPpMenu } = await import("./pp-menu.js");
      await asCommand(() => showPpMenu(orchestrator, ctx));
    },
  });
}
