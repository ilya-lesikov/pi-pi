import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getDefaultConfig, normalizeConfigDurations } from "./config.js";
import { runDoctor } from "./doctor.js";

const dirs: string[] = [];

function makeAgentDir(packages: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "pp-doctor-"));
  dirs.push(dir);
  writeFileSync(join(dir, "settings.json"), JSON.stringify({ packages }), "utf-8");
  return dir;
}

/** Run the doctor against a throwaway agent dir and return everything it reported. */
async function report(agentDir: string): Promise<string> {
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const orchestrator: any = { cwd: agentDir, config: normalizeConfigDurations(getDefaultConfig()) };
  let text = "";
  await runDoctor(orchestrator, { ui: { notify: (message: string) => { text = message; } } }, { probes: false, probeServers: false });
  return text;
}

afterEach(() => {
  delete process.env.PI_CODING_AGENT_DIR;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("runDoctor", () => {
  // A worker session builds its own resource loader, so a second pi-pi checkout
  // declared in settings is what workers actually run — even when the session
  // itself was started with --no-extensions -e against this one.
  it("flags another pi-pi copy declared in settings", async () => {
    const agentDir = makeAgentDir([]);
    const other = mkdtempSync(join(tmpdir(), "pp-other-"));
    dirs.push(other);
    mkdirSync(join(other, "extensions", "orchestrator"), { recursive: true });
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: ["npm:pi-tool-display", other] }), "utf-8");

    expect(await report(agentDir)).toContain(`another pi-pi copy at ${other}`);
  });

  // Entries may be objects, may be ~-relative, and remote sources are not checkouts.
  it("understands every package entry form pi accepts", async () => {
    const agentDir = makeAgentDir([]);
    const other = mkdtempSync(join(tmpdir(), "pp-object-"));
    dirs.push(other);
    mkdirSync(join(other, "extensions", "orchestrator"), { recursive: true });
    writeFileSync(
      join(agentDir, "settings.json"),
      JSON.stringify({ packages: ["npm:pi-tool-display", "github:someone/pi-pi", { source: other }] }),
      "utf-8",
    );

    const text = await report(agentDir);
    expect(text).toContain(`another pi-pi copy at ${other}`);
    expect(text).not.toContain("github:");
  });

  it("stays quiet when settings declare no other checkout", async () => {
    const agentDir = makeAgentDir(["npm:pi-tool-display"]);

    expect(await report(agentDir)).not.toContain("another pi-pi copy");
  });

  it("reports the sections the audit found missing", async () => {
    const text = await report(makeAgentDir([]));

    for (const section of ["Config", "Models", "Extensions", "Tools", "Provisioning", "LSP", "Skills", "Commands", "Flant", "Connectivity", "Environment"]) {
      expect(text).toContain(section);
    }
    expect(text).toMatch(/Summary: \d+ passed, \d+ warnings, \d+ failures/);
  });

  it("names the globalThis handles extensions couple through", async () => {
    // These couplings are invisible to the type checker: a handle that stops
    // being published produces no error, only behavior that quietly stops.
    const text = await report(makeAgentDir([]));

    for (const key of ["pi-subagents:manager", "pi-tasks:store", "pi-lsp:api", "pi-pi:cbm-daemon", "pi-pi:usage-tracker"]) {
      expect(text).toContain(key);
    }
  });

  it("reports each provisioned tool's verification strength, not a uniform claim", async () => {
    const results = (globalThis as any)[Symbol.for("pi-pi:provision-results")] ?? new Map();
    (globalThis as any)[Symbol.for("pi-pi:provision-results")] = results;
    results.set("rg", { status: "installed", binary: "rg", path: "/tmp/rg", verification: "checksum", version: "15.2.0" });
    results.set("rust-analyzer", { status: "installed", binary: "rust-analyzer", path: "/tmp/ra", verification: "none", version: "2026-09-21" });
    try {
      const text = await report(makeAgentDir([]));
      expect(text).toContain("rg: installed 15.2.0 — verification: checksum");
      expect(text).toContain("rust-analyzer: installed 2026-09-21 — verification: none");
      // The weaker guarantee has to say so rather than be inferred from a word.
      expect(text).toContain("transport integrity only");
    } finally {
      results.clear();
    }
  });

  it("surfaces a language server that resolves but does not run, with its stderr", async () => {
    // The rustup-proxy shape: detection passes, the process dies on spawn, and
    // the reason exists only in stderr the user never sees.
    (globalThis as any)[Symbol.for("pi-lsp:api")] = {
      describe: async () => ({
        rootPath: "/repo",
        servers: [{
          name: "rust",
          command: "rust-analyzer",
          resolvedPath: "/home/u/.cargo/bin/rust-analyzer",
          extensions: [".rs"],
          running: false,
          probe: "failed",
          error: "Server process exited",
          stderr: ["error: Unknown binary 'rust-analyzer' in official toolchain"],
        }],
        missing: [{ name: "go", command: ["gopls"], extensions: [".go"] }],
        errors: [],
        globalDisabled: false,
      }),
    };
    try {
      const text = await report(makeAgentDir([]));
      expect(text).toContain("rust: rust-analyzer resolves but does not run");
      expect(text).toContain("Unknown binary 'rust-analyzer' in official toolchain");
      // A language with no server at all must be named, not silently omitted.
      expect(text).toContain("go: no server for .go — wants gopls");
    } finally {
      delete (globalThis as any)[Symbol.for("pi-lsp:api")];
    }
  });

  it("skips network probes when asked, so it works offline", async () => {
    expect(await report(makeAgentDir([]))).toContain("Network probes skipped");
  });
});
