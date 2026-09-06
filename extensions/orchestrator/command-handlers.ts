import type { Orchestrator } from "./orchestrator.js";

export function registerCommandHandlers(orchestrator: Orchestrator): void {
  orchestrator.pi.registerCommand("pp", {
    description: "Open the pi-pi control panel",
    handler: async (_args, ctx) => {
      orchestrator.lastCtx = ctx;
      const { showPpMenu } = await import("./pp-menu.js");
      await showPpMenu(orchestrator, ctx);
    },
  });
}
