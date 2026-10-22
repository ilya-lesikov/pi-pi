import type { Orchestrator } from "./orchestrator.js";
import { bbMenuAvailable, openBbMenu } from "./bb-menu.js";
import { menuNotify } from "./bb-menu-ui.js";
import { asCommand, currentHost } from "./notices.js";

export function registerCommandHandlers(orchestrator: Orchestrator): void {
  orchestrator.pi.registerCommand("pp", {
    description: "Open the pi-pi control panel",
    handler: async (_args, ctx) => {
      orchestrator.lastCtx = ctx;
      // pi's own dialogs do not reach the user in bb outside a model run, and
      // /pp starts none; pi-pi's plugin draws the menu there instead.
      if (currentHost().id === "bb" && await bbMenuAvailable()) {
        const opened = openBbMenu(orchestrator, ctx);
        if (!opened.ok) menuNotify(opened.message, "warning");
        await opened.closed;
        return;
      }
      const { showPpMenu } = await import("./pp-menu.js");
      await asCommand(() => showPpMenu(orchestrator, ctx));
    },
  });
}
