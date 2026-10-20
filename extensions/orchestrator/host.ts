/**
 * What the program hosting pi can show, decided without configuration: from
 * pi's run mode, from the environment variables known orchestrators set on
 * the pi process they spawn, and from how dialogs actually behave.
 */
export type HostId = "tui" | "bb" | "paseo" | "t3" | "orca" | "rpc" | "json" | "print";

type Support = "unknown" | "supported" | "unsupported";

/** bb's extension-UI schema; the tightest of the hosts, and a dialog over it is cancelled unseen. */
export const DIALOG_LIMITS = { title: 200, option: 512, options: 64, placeholder: 1024 };

/** Custom message types that are for the user only and never reach the model. */
export const PRESENTATION_TYPES = new Set(["pp-notice", "pp-report", "subagent-notification", "subagent-update"]);

// A person cannot answer a dialog this fast; an adapter that cancels every
// text dialog it is sent does.
const INSTANT_CANCEL_MS = 50;

export class HostProfile {
  private textInput: Support = "unknown";

  constructor(readonly id: HostId) {}

  get tui(): boolean {
    return this.id === "tui";
  }

  get headless(): boolean {
    return this.id === "json" || this.id === "print";
  }

  /** bb drops notify; everything else shows it, T3 only while a turn is open. */
  get notifyVisible(): boolean {
    return this.id !== "bb" && !this.headless;
  }

  /** T3 drops custom messages, and some ACP adapters do too, which an unmarked host may be. */
  get customMessagesVisible(): boolean | undefined {
    if (this.id === "t3") return false;
    if (this.id === "rpc") return undefined;
    return true;
  }

  /**
   * Whether the host ends its turn for a slash command that starts no model
   * run. Paseo, T3 and Orca probe pi for idleness; bb waits for a run that
   * never comes. Unmarked hosts are unknown: Zeron finishes such turns, pi-acp
   * and MonoCode do not.
   */
  get settlesCommandOnlyPrompt(): boolean | undefined {
    if (this.id === "bb") return false;
    if (this.id === "paseo" || this.id === "t3" || this.id === "orca" || this.id === "tui") return true;
    return undefined;
  }

  /** Whether an optional typed-text step is worth offering. An explicit request for text always tries. */
  get offersText(): boolean {
    return this.textInput !== "unsupported";
  }

  /**
   * Learns from how a text dialog ended. Only a cancel nobody could have made
   * by hand counts, and only one asked while the run was live: an abort or a
   * teardown cancels instantly too.
   */
  observeTextDialog(answered: boolean, elapsedMs: number, runLive: boolean): void {
    if (answered) this.textInput = "supported";
    else if (runLive && elapsedMs < INSTANT_CANCEL_MS && this.textInput !== "supported") this.textInput = "unsupported";
  }
}

export function detectHost(mode: string | undefined, env: NodeJS.ProcessEnv = process.env): HostProfile {
  if (mode === undefined || mode === "tui") return new HostProfile("tui");
  if (mode === "json" || mode === "print") return new HostProfile(mode);
  if (env.BB_THREAD_ID) return new HostProfile("bb");
  if (env.PASEO_AGENT_ID) return new HostProfile("paseo");
  if (env.T3_PI_RUNTIME_MODE) return new HostProfile("t3");
  if (env.ORCA_PANE_KEY || env.ORCA_AGENT_LAUNCH_TOKEN) return new HostProfile("orca");
  return new HostProfile("rpc");
}

/** One line, at most `max` characters: hosts render titles without line breaks, and bb refuses long ones. */
export function fitLine(text: string, max: number): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length <= max ? line : `${line.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}
