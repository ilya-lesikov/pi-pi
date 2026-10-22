import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * pi's bash waits on a command forever unless the call sets a timeout, so a
 * server left in the foreground, a prompt waiting on stdin or a script that
 * never exits holds the turn until someone notices. This gives a call that
 * sets no timeout of its own a default one, by adding it to the call's
 * arguments before it runs.
 *
 * Arguments rather than a bash tool of pi-pi's own: pi refuses to start when
 * two extensions register a tool of one name, and other extensions replace
 * bash too (to draw its output, for one). Whichever bash runs, it reads the
 * same `timeout`.
 *
 * The guidance on commands that do not exit lives in the prompts' tool
 * routing (agents/tool-routing.ts): pi-pi writes both prompts itself, so a
 * tool's promptGuidelines never reach them.
 */
export function registerBashGuard(pi: ExtensionAPI, timeoutSec: () => number): void {
  pi.on("tool_call", async (event) => {
    if (event.toolName !== "bash") return;
    const input = event.input as { timeout?: number | null };
    // Any timeout the agent set is its own, an invalid one included: bash rejects that itself.
    if (input.timeout !== undefined && input.timeout !== null) return;
    const seconds = timeoutSec();
    if (seconds > 0) input.timeout = seconds;
  });
}
