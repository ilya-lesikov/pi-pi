import { readFileSync, existsSync, mkdirSync, readdirSync } from "fs";
import { join } from "path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { PiPiConfig } from "../config.js";
import { registerAgentDefinitions, spawnViaRpc, waitForCompletion } from "../agents/registry.js";
import { createPlannerAgent } from "../agents/planner.js";
import { createPlanReviewerAgent } from "../agents/plan-reviewer.js";
import { getLatestSynthesizedPlan } from "../context.js";

export function planningSystemPrompt(taskDir: string): string {
  const plansDir = join(taskDir, "plans");
  return [
    "[PI-PI — PLANNING PHASE]",
    "",
    "Planning subagents are working in parallel to create plans.",
    `They will write their outputs to ${plansDir}/. This may take several minutes.`,
    "",
    "# FORBIDDEN — do NOT do any of these:",
    "- Do NOT write your own plan from scratch. You are a SYNTHESIZER, not a planner.",
    "- Do NOT create the plans/ directory yourself — the extension manages it.",
    "- Do NOT proceed until at least one planner output file exists.",
    "- Do NOT read project source code directly — the planner outputs already contain the analysis.",
    "- Do NOT call plannotator_submit_plan — plan review is handled by the user via /pp:review-plan.",
    "- If no planner outputs appear after a few minutes, tell the user planners may have failed.",
    "",
    "# Your job (in this order):",
    `1. Wait for planner output files to appear in ${plansDir}/`,
    `2. Read ALL planner outputs from ${plansDir}/`,
    `3. Read ${join(taskDir, "USER_REQUEST.md")} and ${join(taskDir, "RESEARCH.md")} for context`,
    `4. Synthesize all plans into a single plan at ${plansDir}/<timestamp>_synthesized.md`,
    "5. Ask the user for clarifications if unsure about anything",
    "6. If the user wants changes, update the synthesized plan",
    "",
    "Plan format:",
    "- Use checkboxes (- [ ]) for every actionable item",
    "- Describe WHAT, not HOW at the code level",
    "- No code snippets",
    "- Group items under headings",
    "",
    "When the synthesized plan is ready, run /pp:next (slash command, not a tool call).",
    "The extension will ask the user for approval before transitioning.",
  ].join("\n");
}

export async function spawnPlanners(
  pi: ExtensionAPI,
  cwd: string,
  taskDir: string,
  taskId: string,
  config: PiPiConfig,
): Promise<void> {
  const urPath = join(taskDir, "USER_REQUEST.md");
  const resPath = join(taskDir, "RESEARCH.md");
  if (!existsSync(urPath) || !existsSync(resPath)) return;

  const userRequest = readFileSync(urPath, "utf-8");
  const research = readFileSync(resPath, "utf-8");

  const plansDir = join(taskDir, "plans");
  if (!existsSync(plansDir)) {
    mkdirSync(plansDir, { recursive: true });
  }

  const timestamp = Math.floor(Date.now() / 1000);
  const enabledVariants = Object.entries(config.planners).filter(([, v]) => v.enabled);
  const results: Promise<void>[] = [];

  for (const [variant] of enabledVariants) {
    const outputPath = join(plansDir, `${timestamp}_${variant}.md`);
    const agent = createPlannerAgent(variant, config, { userRequest, research }, outputPath);

    registerAgentDefinitions(pi, [{ type: "planner", variant, ...agent }]);

    results.push(
      (async () => {
        try {
          const { id } = await spawnViaRpc(pi, `planner_${variant}`, agent.prompt, {
            description: `Planner (${variant})`,
          });
          await waitForCompletion(pi, id);
        } catch (err: any) {
          pi.sendMessage(
            {
              customType: "pp-planner-error",
              content: `Planner variant "${variant}" failed: ${err.message}`,
              display: true,
            },
            { deliverAs: "steer" },
          );
        }
      })(),
    );
  }

  await Promise.allSettled(results);

  const planFiles = existsSync(plansDir) ? readdirSync(plansDir).filter((f) => !f.includes("synthesized")) : [];
  if (planFiles.length > 0) {
    pi.sendMessage(
      {
        customType: "pp-planners-done",
        content: [
          `${planFiles.length} planner(s) completed. Plans available in ${plansDir}:`,
          ...planFiles.map((f) => `  - ${f}`),
          "",
          "Read all plans and synthesize them into a single plan.",
        ].join("\n"),
        display: true,
      },
      { deliverAs: "steer" },
    );
  } else {
    pi.sendMessage(
      {
        customType: "pp-planners-error",
        content: [
          "All planner variants failed — no plan files were produced.",
          "You must create the plan yourself based on USER_REQUEST.md and RESEARCH.md.",
        ].join("\n"),
        display: true,
      },
      { deliverAs: "steer" },
    );
  }
}

export async function spawnPlanReviewers(
  pi: ExtensionAPI,
  cwd: string,
  taskDir: string,
  taskId: string,
  config: PiPiConfig,
): Promise<string[]> {
  const urPath = join(taskDir, "USER_REQUEST.md");
  const resPath = join(taskDir, "RESEARCH.md");
  if (!existsSync(urPath) || !existsSync(resPath)) return [];

  const userRequest = readFileSync(urPath, "utf-8");
  const research = readFileSync(resPath, "utf-8");
  const synthesizedPlan = getLatestSynthesizedPlan(taskDir);
  if (!synthesizedPlan) return [];

  const timestamp = Math.floor(Date.now() / 1000);
  const enabledVariants = Object.entries(config.planReviewers).filter(([, v]) => v.enabled);
  const reviewFiles: string[] = [];

  const results: Promise<void>[] = [];
  for (const [variant] of enabledVariants) {
    const outputPath = join(taskDir, "plans", `${timestamp}_review_${variant}.md`);
    reviewFiles.push(outputPath);

    const agent = createPlanReviewerAgent(variant, config, { userRequest, research, synthesizedPlan }, outputPath);

    registerAgentDefinitions(pi, [{ type: "plan_reviewer", variant, ...agent }]);

    results.push(
      (async () => {
        try {
          const { id } = await spawnViaRpc(pi, `plan_reviewer_${variant}`, agent.prompt, {
            description: `Plan reviewer (${variant})`,
          });
          await waitForCompletion(pi, id);
        } catch (err: any) {
          pi.sendMessage(
            {
              customType: "pp-plan-reviewer-error",
              content: `Plan reviewer variant "${variant}" failed: ${err.message}`,
              display: true,
            },
            { deliverAs: "steer" },
          );
        }
      })(),
    );
  }

  await Promise.allSettled(results);

  const plansDir = join(taskDir, "plans");
  const actualReviewFiles = existsSync(plansDir)
    ? readdirSync(plansDir).filter((f) => f.includes("review_") && f.startsWith(`${timestamp}`))
    : [];

  if (actualReviewFiles.length > 0) {
    pi.sendMessage(
      {
        customType: "pp-plan-reviews-done",
        content: [
          `${actualReviewFiles.length} plan reviewer(s) completed. Reviews in ${plansDir}:`,
          ...actualReviewFiles.map((f) => `  - ${f}`),
          "",
          "Read all plan reviews and incorporate feedback into the synthesized plan if needed.",
        ].join("\n"),
        display: true,
      },
      { deliverAs: "steer" },
    );
  } else if (enabledVariants.length > 0) {
    pi.sendMessage(
      {
        customType: "pp-plan-reviews-error",
        content: "All plan reviewer variants failed — no reviews were produced. Proceeding without plan review.",
        display: true,
      },
      { deliverAs: "steer" },
    );
  }

  return reviewFiles;
}
