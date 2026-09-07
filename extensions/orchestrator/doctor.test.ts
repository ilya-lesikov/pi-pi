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
  await runDoctor(orchestrator, { ui: { notify: (message: string) => { text = message; } } });
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

  it("stays quiet when settings declare no other checkout", async () => {
    const agentDir = makeAgentDir(["npm:pi-tool-display"]);

    expect(await report(agentDir)).not.toContain("another pi-pi copy");
  });
});
