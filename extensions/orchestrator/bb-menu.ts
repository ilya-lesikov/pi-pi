import { bbForms } from "./bb-forms.js";
import { CLOSED_BY_PI, MenuAborted, menuContext, menuNotify, setActiveMenu, type MenuSession } from "./bb-menu-ui.js";
import { getLogger } from "./log.js";
import type { Orchestrator } from "./orchestrator.js";

const MENU_FORMS = ["ask", "confirm", "input", "report"] as const;

let open: AbortController | null = null;

/**
 * Opens /pp in bb's composer, drawn by pi-pi's plugin, and returns at once:
 * the menu runs on its own, for as long as the user keeps it open. Only while
 * the agent is idle: a run that starts takes it down, so a setting never
 * changes under a turn, and the menu's forms never compete with the agent's.
 */
export function openBbMenu(orchestrator: Orchestrator, ctx: any = orchestrator.lastCtx): { ok: boolean; message: string; closed?: Promise<void> } {
  if (open) return { ok: false, message: "pi-pi's menu is already open." };
  const forms = bbForms();
  if (!ctx || !forms) return { ok: false, message: "pi-pi is still starting; try again in a moment." };
  if (orchestrator.mainTurnInFlight || orchestrator.holdingRun || ctx.isIdle?.() === false) {
    return { ok: false, message: "pi-pi's menu opens while the agent is idle." };
  }
  const controller = new AbortController();
  open = controller;
  const session: MenuSession = { forms, signal: controller.signal };
  const closed = (async () => {
    try {
      const supported = await forms.supports(MENU_FORMS);
      if (supported === null) {
        menuNotify("pi-pi could not reach its bb plugin; try again in a moment.", "warning");
        return;
      }
      if (!supported) {
        menuNotify("pi-pi's bb plugin cannot show the menu; update it, or use /pp in a terminal.", "error");
        return;
      }
      setActiveMenu(session);
      const { showPpMenu } = await import("./pp-menu.js");
      await showPpMenu(orchestrator, menuContext(ctx, session));
    } catch (error) {
      // Taken down by pi-pi itself (a run started, the session changed): nothing to say.
      if (error instanceof MenuAborted && error.reason === CLOSED_BY_PI) return;
      const reason = error instanceof MenuAborted ? error.reason : (error as Error)?.message ?? String(error);
      getLogger().warn({ s: "bb-menu", err: reason }, "pi-pi's bb menu closed");
      menuNotify(`pi-pi's menu closed: ${reason}`, "warning");
    } finally {
      setActiveMenu(null);
      if (open === controller) open = null;
    }
  })();
  return { ok: true, message: "Opened pi-pi's menu.", closed };
}

/** Takes the menu down, its open form included. */
export function closeBbMenu(): void {
  open?.abort();
}

/** Whether pi-pi's plugin can draw the menu here. */
export async function bbMenuAvailable(): Promise<boolean> {
  return (await bbForms()?.supports(MENU_FORMS)) === true;
}
