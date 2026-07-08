import { existsSync, readFileSync } from "fs";
import { join } from "path";
import type { TaskType, Phase } from "../state.js";
import { getLatestSynthesizedPlan, hasFinalPassAnchors } from "../context.js";
import { validatePlan, validateResearch, validateUserRequest } from "../validate-artifacts.js";

const USER_REQUEST_TEMPLATE = [
  "# User Request",
  "<1-3 sentence distillation>",
  "",
  "## Problem",
  "<What's broken, user's perspective>",
  "",
  "## Constraints",
  "<User-stated boundaries>",
].join("\n");

const RESEARCH_TEMPLATE = [
  "## Affected Code",
  "<file:symbol — one-line role, per line>",
  "",
  "## Architecture Context",
  "<Dense bullets. How affected pieces connect.>",
  "",
  "## Constraints & Edge Cases",
  "- MUST: <hard requirements discovered from code>",
  "- RISK: <things that could break>",
  "",
  "## Open Questions",
  "<Unresolved items needing user input. Omit section if none.>",
].join("\n");

const PLAN_TEMPLATE = [
  "# Plan",
  "",
  "## Scope",
  "<2-4 lines summarizing what changes and what doesn't>",
  "",
  "## Checklist",
  "- [ ] <Outcome> — Done when: <observable condition>",
  "",
  "## Blockers",
  "<Unresolved issues. Omit section if none.>",
].join("\n");

function isMissingOrEmpty(filePath: string): boolean {
  return !existsSync(filePath) || readFileSync(filePath, "utf-8").trim().length === 0;
}

function formatValidationErrors(fileName: string, errors: string[], expectedStructure: string): string {
  return `${fileName} validation failed:\n${errors.map((error) => `- ${error}`).join("\n")}\n\nExpected structure:\n${expectedStructure}`;
}

const TRANSITIONS: Record<TaskType, Record<string, string[]>> = {
  implement: {
    brainstorm: ["plan"],
    plan: ["implement"],
    implement: ["done"],
  },
  debug: {
    debug: ["plan"],
    plan: ["implement"],
    implement: ["done"],
  },
  brainstorm: {
    brainstorm: ["plan"],
    plan: ["implement"],
    implement: ["done"],
  },
  review: {
    review: ["plan"],
    plan: ["implement"],
    implement: ["done"],
  },
  quick: {
    quick: ["done"],
  },
};

export function canTransition(taskType: TaskType, from: Phase, to: Phase): boolean {
  const targets = TRANSITIONS[taskType]?.[from];
  return targets?.includes(to) ?? false;
}

export function nextPhase(taskType: TaskType, from: Phase): Phase | null {
  const targets = TRANSITIONS[taskType]?.[from];
  return targets?.[0] as Phase | null ?? null;
}

export function validateExitCriteria(
  taskDir: string,
  taskType: TaskType,
  phase: Phase,
): { ok: true } | { ok: false; reason: string } {
  switch (phase) {
    case "brainstorm": {
      if (taskType === "brainstorm") {
        return { ok: true };
      }

      const ur = join(taskDir, "USER_REQUEST.md");
      const res = join(taskDir, "RESEARCH.md");
      if (isMissingOrEmpty(ur)) {
        return { ok: false, reason: "USER_REQUEST.md does not exist or is empty" };
      }
      if (isMissingOrEmpty(res)) {
        return { ok: false, reason: "RESEARCH.md does not exist or is empty" };
      }
      const urContent = readFileSync(ur, "utf-8");
      const resContent = readFileSync(res, "utf-8");

      const userRequestValidation = validateUserRequest(urContent);
      if (!userRequestValidation.ok) {
        return {
          ok: false,
          reason: formatValidationErrors("USER_REQUEST.md", userRequestValidation.errors, USER_REQUEST_TEMPLATE),
        };
      }

      const researchValidation = validateResearch(resContent);
      if (!researchValidation.ok) {
        return {
          ok: false,
          reason: formatValidationErrors("RESEARCH.md", researchValidation.errors, RESEARCH_TEMPLATE),
        };
      }

      return { ok: true };
    }

    case "review": {
      const ur = join(taskDir, "USER_REQUEST.md");
      const res = join(taskDir, "RESEARCH.md");
      if (isMissingOrEmpty(ur)) {
        return { ok: false, reason: "USER_REQUEST.md does not exist or is empty" };
      }
      if (isMissingOrEmpty(res)) {
        return { ok: false, reason: "RESEARCH.md does not exist or is empty" };
      }
      const urContent = readFileSync(ur, "utf-8");
      const resContent = readFileSync(res, "utf-8");

      const userRequestValidation = validateUserRequest(urContent);
      if (!userRequestValidation.ok) {
        return {
          ok: false,
          reason: formatValidationErrors("USER_REQUEST.md", userRequestValidation.errors, USER_REQUEST_TEMPLATE),
        };
      }

      const researchValidation = validateResearch(resContent);
      if (!researchValidation.ok) {
        return {
          ok: false,
          reason: formatValidationErrors("RESEARCH.md", researchValidation.errors, RESEARCH_TEMPLATE),
        };
      }

      if (!hasFinalPassAnchors(taskDir)) {
        return {
          ok: false,
          reason:
            "No ANCHORS-bearing final review file exists. Write the review findings to " +
            "`code-reviews/*_final_pass-*.md` with an `ANCHORS:` block (use `ANCHORS: (none)` " +
            "if there are no findings) before completing the review.",
        };
      }

      return { ok: true };
    }

    case "plan": {
      const plan = getLatestSynthesizedPlan(taskDir);
      if (!plan) {
        return { ok: false, reason: "No synthesized plan found in plans/" };
      }

      const planValidation = validatePlan(plan);
      if (!planValidation.ok) {
        return {
          ok: false,
          reason: formatValidationErrors("Synthesized plan", planValidation.errors, PLAN_TEMPLATE),
        };
      }

      return { ok: true };
    }

    case "implement": {
      const content = getLatestSynthesizedPlan(taskDir);
      if (!content) {
        return { ok: false, reason: "No synthesized plan found" };
      }

      const planValidation = validatePlan(content);
      if (!planValidation.ok) {
        return {
          ok: false,
          reason: formatValidationErrors("Synthesized plan", planValidation.errors, PLAN_TEMPLATE),
        };
      }

      const checklistStart = content.indexOf("## Checklist");
      const checklistEnd = checklistStart === -1 ? -1 : content.indexOf("\n## ", checklistStart + 1);
      const checklistContent = checklistStart === -1
        ? ""
        : checklistEnd === -1
        ? content.slice(checklistStart)
        : content.slice(checklistStart, checklistEnd);
      const unchecked = checklistContent.match(/^- \[ \]/gm);
      if (unchecked && unchecked.length > 0) {
        return { ok: false, reason: `${unchecked.length} plan items still unchecked` };
      }
      return { ok: true };
    }

    case "debug": {
      const ur = join(taskDir, "USER_REQUEST.md");
      const res = join(taskDir, "RESEARCH.md");
      if (isMissingOrEmpty(ur)) {
        return { ok: false, reason: "USER_REQUEST.md does not exist or is empty" };
      }
      if (isMissingOrEmpty(res)) {
        return { ok: false, reason: "RESEARCH.md does not exist or is empty" };
      }
      const urContent = readFileSync(ur, "utf-8");
      const resContent = readFileSync(res, "utf-8");

      const userRequestValidation = validateUserRequest(urContent);
      if (!userRequestValidation.ok) {
        return {
          ok: false,
          reason: formatValidationErrors("USER_REQUEST.md", userRequestValidation.errors, USER_REQUEST_TEMPLATE),
        };
      }

      const researchValidation = validateResearch(resContent);
      if (!researchValidation.ok) {
        return {
          ok: false,
          reason: formatValidationErrors("RESEARCH.md", researchValidation.errors, RESEARCH_TEMPLATE),
        };
      }

      return { ok: true };
    }

    case "quick": {
      return { ok: true };
    }

    default:
      return { ok: false, reason: `Unknown phase: ${phase}` };
  }
}

export function phasePipeline(taskType: TaskType): Phase[] {
  switch (taskType) {
    case "implement":
      return ["brainstorm", "plan", "implement", "done"];
    case "debug":
      return ["debug", "plan", "implement", "done"];
    case "brainstorm":
      return ["brainstorm", "plan", "implement", "done"];
    case "review":
      return ["review", "plan", "implement", "done"];
    case "quick":
      return ["quick", "done"];
  }
}
