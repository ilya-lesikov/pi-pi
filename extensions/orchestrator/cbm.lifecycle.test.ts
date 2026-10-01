import { describe, it, expect, afterEach } from "vitest";
import { CbmDaemon } from "./cbm.js";

const CBM_BIN_KEY = Symbol.for("pi-pi:cbm-bin");

// A binary that exits immediately, standing in for a codebase-memory-mcp that
// cannot start. The daemon is launched eagerly at extension load, long before
// any cbm_* tool runs, so nothing is awaiting its init promise at that point.
const EXITS_IMMEDIATELY = process.platform === "win32" ? "cmd.exe" : "false";

function collectFatalEvents(): { events: string[]; stop: () => void } {
  const events: string[] = [];
  const onRejection = (reason: unknown) => events.push(`unhandledRejection: ${reason}`);
  const onException = (err: unknown) => events.push(`uncaughtException: ${err}`);
  process.on("unhandledRejection", onRejection);
  process.on("uncaughtException", onException);
  return {
    events,
    stop: () => {
      process.off("unhandledRejection", onRejection);
      process.off("uncaughtException", onException);
    },
  };
}

const settle = async () => {
  await new Promise((r) => setTimeout(r, 500));
  await new Promise((r) => setImmediate(r));
};

describe("CbmDaemon survives a child that dies before any tool call", () => {
  afterEach(() => {
    (globalThis as any)[CBM_BIN_KEY] = undefined;
  });

  it("does not leave the init rejection unobserved when the child exits", async () => {
    (globalThis as any)[CBM_BIN_KEY] = EXITS_IMMEDIATELY;
    const fatal = collectFatalEvents();

    const daemon = new CbmDaemon();
    daemon.start();
    await settle();

    fatal.stop();
    daemon.stop();

    expect(fatal.events).toEqual([]);
  });

  it("does not let an EPIPE write to the dead child escape as a fatal error", async () => {
    (globalThis as any)[CBM_BIN_KEY] = EXITS_IMMEDIATELY;
    const fatal = collectFatalEvents();

    const daemon = new CbmDaemon();
    daemon.start();
    await new Promise((r) => setTimeout(r, 300));
    await expect(daemon.callTool("search_graph", {}, 1000)).rejects.toThrow();
    await settle();

    fatal.stop();
    daemon.stop();

    expect(fatal.events).toEqual([]);
  });
});
