import { existsSync, readFileSync } from "fs";
import { join } from "path";
import type { TaskType, Phase } from "../state.js";
import { getLatestSynthesizedPlan } from "../context.js";

const TRANSITIONS: Record<TaskType, Record<string, string[]>> = {
  implement: {
    brainstorm: ["plan"],
    plan: ["implement"],
    implement: ["done"],
  },
  debug: {
    debug: ["done"],
  },
  brainstorm: {
    brainstorm: ["done"],
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
      const ur = join(taskDir, "USER_REQUEST.md");
      const res = join(taskDir, "RESEARCH.md");
      if (!existsSync(ur) || readFileSync(ur, "utf-8").trim().length === 0) {
        return { ok: false, reason: "USER_REQUEST.md does not exist or is empty" };
      }
      if (!existsSync(res) || readFileSync(res, "utf-8").trim().length === 0) {
        return { ok: false, reason: "RESEARCH.md does not exist or is empty" };
      }
      return { ok: true };
    }

    case "plan": {
      const plan = getLatestSynthesizedPlan(taskDir);
      if (!plan) {
        return { ok: false, reason: "No synthesized plan found in plans/" };
      }
      return { ok: true };
    }

    case "implement": {
      const content = getLatestSynthesizedPlan(taskDir);
      if (!content) {
        return { ok: false, reason: "No synthesized plan found" };
      }
      const unchecked = content.match(/^- \[ \]/gm);
      if (unchecked && unchecked.length > 0) {
        return { ok: false, reason: `${unchecked.length} plan items still unchecked` };
      }
      return { ok: true };
    }

    case "debug": {
      const ur = join(taskDir, "USER_REQUEST.md");
      const res = join(taskDir, "RESEARCH.md");
      if (!existsSync(ur) || readFileSync(ur, "utf-8").trim().length === 0) {
        return { ok: false, reason: "USER_REQUEST.md does not exist or is empty" };
      }
      if (!existsSync(res) || readFileSync(res, "utf-8").trim().length === 0) {
        return { ok: false, reason: "RESEARCH.md does not exist or is empty" };
      }
      return { ok: true };
    }

    case "brainstorm":
      return { ok: true };

    default:
      return { ok: false, reason: `Unknown phase: ${phase}` };
  }
}

export function phasePipeline(taskType: TaskType): Phase[] {
  switch (taskType) {
    case "implement":
      return ["brainstorm", "plan", "implement", "done"];
    case "debug":
      return ["debug", "done"];
    case "brainstorm":
      return ["brainstorm", "done"];
  }
}
