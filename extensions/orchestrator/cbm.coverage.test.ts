import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CbmDaemon, forgetMissingCbmBin } from "./cbm.js";

const CBM_BIN_KEY = Symbol.for("pi-pi:cbm-bin");

// A stand-in codebase-memory-mcp speaking line-delimited JSON-RPC, with the noise
// a real one produces: blank lines, log lines on stdout, chatter on stderr.
const FAKE_SERVER = `#!/usr/bin/env node
const rl = require("readline").createInterface({ input: process.stdin });
const seen = [];
process.stderr.write("starting up\\n");
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  seen.push(msg.method);
  process.stdout.write("\\nnot json at all\\n");
  if (msg.method === "initialize") return reply(msg.id, { result: { ok: true } });
  if (msg.id == null) return;
  const name = msg.params.name;
  if (name === "seen") return reply(msg.id, { result: { content: [{ type: "text", text: JSON.stringify(seen) }] } });
  if (name === "rpc_error") return reply(msg.id, { error: { message: "graph is gone" } });
  if (name === "rpc_error_bare") return reply(msg.id, { error: { code: 7 } });
  if (name === "hang") return;
  if (name === "unknown_id") return reply(9999, { result: {} });
});
function reply(id, body) { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, ...body }) + "\\n"); }
`;

let dir: string;
let bin: string;
const daemons: CbmDaemon[] = [];

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "cbm-fake-"));
  bin = join(dir, "codebase-memory-mcp");
  writeFileSync(bin, FAKE_SERVER);
  chmodSync(bin, 0o755);
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

afterEach(() => {
  for (const daemon of daemons.splice(0)) daemon.stop();
  (globalThis as any)[CBM_BIN_KEY] = undefined;
});

function daemon(): CbmDaemon {
  (globalThis as any)[CBM_BIN_KEY] = bin;
  const created = new CbmDaemon();
  daemons.push(created);
  return created;
}

describe.skipIf(process.platform === "win32")("CbmDaemon against a JSON-RPC server", () => {
  it("initializes, sends the initialized notification, and ignores noise on stdout", async () => {
    const d = daemon();
    expect(await d.callTool("seen", {}, 5000)).toEqual(["initialize", "notifications/initialized", "tools/call"]);
  });

  it("starts only once however often it is asked", async () => {
    const d = daemon();
    d.start();
    const proc = (d as any).proc;
    d.start();
    expect((d as any).proc).toBe(proc);
    await d.callTool("seen", {}, 5000);
  });

  it("surfaces an RPC error by its message, or the whole error when it has none", async () => {
    const d = daemon();
    await expect(d.callTool("rpc_error", {}, 5000)).rejects.toThrow("graph is gone");
    await expect(d.callTool("rpc_error_bare", {}, 5000)).rejects.toThrow('{"code":7}');
  });

  it("times out a call the server never answers, ignoring replies to ids it never sent", async () => {
    const d = daemon();
    await expect(d.callTool("unknown_id", {}, 300)).rejects.toThrow("CBM call timed out: tools/call");
    await expect(d.callTool("hang", {}, 300)).rejects.toThrow("CBM call timed out: tools/call");
  });

  it("rejects calls in flight when it is stopped, and refuses calls with nothing running", async () => {
    const d = daemon();
    await d.callTool("seen", {}, 5000);
    const pending = d.callTool("hang", {}, 60_000);
    await new Promise((resolve) => setTimeout(resolve, 50));
    d.stop();
    await expect(pending).rejects.toThrow("CBM daemon exited");
    d.stop();
    await expect((d as any).rpc("tools/call", {})).rejects.toThrow("CBM daemon not running");
  });

  it("cleans up when the binary cannot be spawned", async () => {
    (globalThis as any)[CBM_BIN_KEY] = join(dir, "missing-binary");
    const d = new CbmDaemon();
    daemons.push(d);
    await expect(d.callTool("seen", {}, 5000)).rejects.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect((d as any).proc).toBeNull();
  });
});

describe("forgetMissingCbmBin", () => {
  it("forgets a miss but keeps a resolved path", () => {
    (globalThis as any)[CBM_BIN_KEY] = null;
    forgetMissingCbmBin();
    expect((globalThis as any)[CBM_BIN_KEY]).toBeUndefined();
    (globalThis as any)[CBM_BIN_KEY] = "/usr/bin/cbm";
    forgetMissingCbmBin();
    expect((globalThis as any)[CBM_BIN_KEY]).toBe("/usr/bin/cbm");
  });
});
