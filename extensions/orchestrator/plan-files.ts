import { existsSync, readdirSync, readFileSync } from "fs";
import { join } from "path";
import { validatePlan } from "./validate-artifacts.js";

// The single-line stub a planner writes as its FIRST action, before it has
// produced any plan content. Exported so the two validatePlan enforcement points
// can recognize (and skip validating) a file that is deliberately not a plan yet.
export const PLAN_STUB_CONTENT = "PLAN_STATUS: INCOMPLETE";

// True when the content is nothing but the INCOMPLETE stub marker. A stub is
// structurally invalid as a plan by design, so both validatePlan gates must let
// it through rather than burying the planner in structure errors on its first
// action.
export function isPlanStub(content: string): boolean {
  return /^\s*PLAN_STATUS\s*:\s*INCOMPLETE\s*$/i.test(content);
}

// A plan is COMPLETE only when the model finished and marked it so. The planner
// prompt writes a `PLAN_STATUS: INCOMPLETE` stub FIRST and overwrites it ending
// in `PLAN_STATUS: COMPLETE`; a file that still says INCOMPLETE (or was never
// overwritten) is NOT a finished plan. Mirrors isReviewComplete.
export function isPlanComplete(content: string): boolean {
  if (/PLAN_STATUS\s*:\s*INCOMPLETE/i.test(content)) return false;
  if (/PLAN_STATUS\s*:\s*COMPLETE/i.test(content)) return true;
  // Legacy plans (written before the stub-first convention) carry no marker;
  // treat a structurally valid non-empty plan as complete so historical tasks
  // still resume instead of being respawned forever.
  return content.trim().length > 0 && validatePlan(content).ok;
}

// A planner variant's output file is `<epoch>_<variant>.md`; synthesized plans
// and review files live in the same directory and are not variant outputs.
function variantOfPlanFile(filename: string): string {
  return filename.replace(/^\d+_/, "").replace(/\.md$/, "");
}

export interface PlanVariantClassification {
  /** Absolute paths of files that are finished plans, one entry per file. */
  completeFiles: string[];
  /** Variants having at least one complete file. */
  completeVariants: Set<string>;
  /** Enabled variants with no complete file (stub-only, malformed, or absent). */
  incompleteVariants: string[];
}

// Classify a plans directory against the enabled planner variants, combining the
// filename→variant mapping with the content-completeness rule. Every gate and
// every synthesis instruction consumes THIS, so the two cannot drift apart.
//
// A variant counts as complete when ANY of its files is complete: a respawn
// writes a new `<epoch>_<variant>.md` and leaves the earlier INCOMPLETE stub
// beside it, so requiring the newest or only file to be complete would treat a
// successful respawn as unfinished.
export function classifyPlanVariants(plansDir: string, enabledVariants: string[]): PlanVariantClassification {
  const files = existsSync(plansDir)
    ? readdirSync(plansDir).filter((f) => f.endsWith(".md") && !f.includes("synthesized") && !f.includes("review_"))
    : [];

  const completeFiles: string[] = [];
  const completeVariants = new Set<string>();
  for (const file of files) {
    const full = join(plansDir, file);
    let content = "";
    try {
      content = readFileSync(full, "utf-8");
    } catch {
      continue;
    }
    if (!isPlanComplete(content)) continue;
    completeFiles.push(full);
    completeVariants.add(variantOfPlanFile(file));
  }

  return {
    completeFiles,
    completeVariants,
    incompleteVariants: enabledVariants.filter((name) => !completeVariants.has(name)),
  };
}
