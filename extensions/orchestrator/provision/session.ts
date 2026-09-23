/**
 * When provisioning runs, and how what it installs becomes reachable.
 *
 * Everything pi-pi installs lands in one directory that is not on the user's
 * PATH, so the directory is prepended to this process's PATH. Every existing
 * lookup — cbm's findCbmBin, pi-lsp's server detection, a plain `which` from a
 * tool — then finds an installed binary without knowing provisioning exists.
 * Prepending affects this process and its children only; the user's shell
 * environment is untouched.
 */

import { getLogger } from "../log.js";
import { nodeProvisionEffects } from "./effects.js";
import { provision, provisionDir, type ProvisionOutcome } from "./install.js";
import { eagerTools, toolsFor, toolsForExtension } from "./manifest.js";

const RESULTS_KEY = Symbol.for("pi-pi:provision-results");
const INFLIGHT_KEY = Symbol.for("pi-pi:provision-inflight");

function results(): Map<string, ProvisionOutcome> {
  const existing = (globalThis as any)[RESULTS_KEY];
  if (existing) return existing;
  const fresh = new Map<string, ProvisionOutcome>();
  (globalThis as any)[RESULTS_KEY] = fresh;
  return fresh;
}

function inflight(): Map<string, Promise<ProvisionOutcome>> {
  const existing = (globalThis as any)[INFLIGHT_KEY];
  if (existing) return existing;
  const fresh = new Map<string, Promise<ProvisionOutcome>>();
  (globalThis as any)[INFLIGHT_KEY] = fresh;
  return fresh;
}

export function provisionResults(): ProvisionOutcome[] {
  return [...results().values()];
}

export function ensureProvisionDirOnPath(dir: string = provisionDir()): void {
  const separator = process.platform === "win32" ? ";" : ":";
  const current = process.env.PATH ?? "";
  if (current.split(separator).includes(dir)) return;
  process.env.PATH = current ? `${dir}${separator}${current}` : dir;
}

/**
 * Install one binary at most once per process, even when several callers ask
 * at the same time. A language server is requested by whichever tool call
 * needs it first, and two concurrent calls on the same language must not race
 * two downloads into the same path.
 */
export async function ensureTool(binary: string): Promise<ProvisionOutcome> {
  const done = results().get(binary);
  if (done) return done;
  const running = inflight().get(binary);
  if (running) return running;

  const task = provision(nodeProvisionEffects, toolsFor(binary))
    .then((outcome) => {
      results().set(binary, outcome);
      inflight().delete(binary);
      if (outcome.status === "installed") {
        getLogger().info({ s: "provision", bin: binary, via: outcome.verification }, "installed a missing tool");
      } else if (outcome.status === "failed") {
        getLogger().debug({ s: "provision", bin: binary, why: outcome.reason }, "could not install a tool");
      }
      return outcome;
    })
    .catch((error: any) => {
      const outcome: ProvisionOutcome = { status: "failed", binary, reason: error?.message ?? String(error) };
      results().set(binary, outcome);
      inflight().delete(binary);
      return outcome;
    });

  inflight().set(binary, task);
  return task;
}

/**
 * Install the language server for a file's extension, if one is declared and
 * not already present. Returns null when pi-pi provisions nothing for that
 * language — which is a different answer from an install that failed.
 */
export async function ensureServerForFile(filePath: string): Promise<ProvisionOutcome | null> {
  const extension = filePath.slice(filePath.lastIndexOf("."));
  const candidates = toolsForExtension(extension);
  if (candidates.length === 0) return null;
  return ensureTool(candidates[0].binary);
}

/**
 * Fetch the always-needed tools, reporting which ones newly arrived so a
 * caller can re-offer whatever it had skipped for want of them. Failures are
 * logged, never thrown: a session that cannot reach GitHub must still start,
 * with the same degraded behavior it had before provisioning existed.
 */
export async function provisionEagerTools(): Promise<ProvisionOutcome[]> {
  ensureProvisionDirOnPath();
  const outcomes = await Promise.all(eagerTools().map((tool) => ensureTool(tool.binary)));
  return outcomes.filter((outcome) => outcome.status === "installed");
}
