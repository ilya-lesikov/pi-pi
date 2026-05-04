import { readFileSync, existsSync, mkdirSync, readdirSync } from "fs";
import { join } from "path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { PiPiConfig } from "../config.js";
import { registerAgentDefinitions, spawnViaRpc, waitForCompletion } from "../agents/registry.js";
import { createCodeReviewerAgent } from "../agents/code-reviewer.js";
import { getLatestSynthesizedPlan } from "../context.js";

export function reviewSystemPrompt(taskDir: string, pass: number, manualReview = false, phase?: string): string {
  const reviewsDir = phase === "brainstorm" ? join(taskDir, "brainstorm-reviews") : join(taskDir, "code-reviews");
  const plansDir = join(taskDir, "plans");

  if (phase === "brainstorm") {
    return [
      `[PI-PI — BRAINSTORM REVIEW CYCLE (pass ${pass})]`,
      "",
      "Brainstorm reviewer outputs are ready.",
      `Read them from ${reviewsDir}/, synthesize feedback, and revise USER_REQUEST.md + RESEARCH.md if needed.`,
      "",
      "# FORBIDDEN:",
      "- Do NOT modify project source code",
      "- Do NOT write your own review from scratch",
      "",
      "# Your job:",
      `1. Read ALL reviewer outputs from ${reviewsDir}/`,
      "2. Identify valid gaps and inaccuracies",
      "3. Revise USER_REQUEST.md and/or RESEARCH.md to address legitimate issues",
      "4. Ignore suggestions that don't affect downstream planning quality",
      "",
      "When revisions are complete (or no changes needed), call pp_phase_complete with a brief summary.",
    ].join("\n");
  }

  if (manualReview) {
    return [
      `[PI-PI — REVIEW CYCLE (pass ${pass}, manual)]`,
      "",
      "Review the implementation yourself using the available tools.",
      "",
      `Write your review to ${reviewsDir}/<timestamp>_final_pass-${pass}.md`,
      "",
      "If changes are needed:",
      `1. Create a fix plan at ${plansDir}/<timestamp>_<description>.md`,
      "2. Implement the fixes",
      "3. Run afterImplement commands",
      "",
    "When done, call pp_phase_complete with a brief summary.",
    ].join("\n");
  }

  return [
    `[PI-PI — REVIEW CYCLE (pass ${pass})]`,
    "",
    "Code reviewer outputs are ready.",
    `Read them from ${reviewsDir}/, synthesize feedback, and implement fixes if needed.`,
    "",
    "# FORBIDDEN — do NOT do any of these:",
    "- Do NOT write your own code review from scratch. You are a SYNTHESIZER, not a reviewer.",
    "- Do NOT create the code-reviews/ directory yourself — the extension manages it.",
    "- Do NOT call plannotator_submit_plan — code review is handled by the user via /pp:review-code.",
    "",
    "# Your job (in this order):",
    `1. Read ALL reviewer outputs from ${reviewsDir}/`,
    `2. Synthesize into ${reviewsDir}/<timestamp>_final_pass-${pass}.md`,
    "3. Present the synthesis to the user",
    "",
    "If changes are needed:",
    `1. Create a fix plan at ${plansDir}/<timestamp>_<description>.md (do NOT modify the original synthesized plan)`,
    "2. Implement the fixes",
    "3. Run afterImplement commands",
    "4. A new review pass will begin",
    "",
    "When the synthesized review is ready, call pp_phase_complete with a brief summary.",
  ].join("\n");
}

export async function spawnCodeReviewers(
  pi: ExtensionAPI,
  cwd: string,
  taskDir: string,
  taskId: string,
  config: PiPiConfig,
  round: number,
): Promise<{ spawned: number; agentIds: string[] }> {
  const urPath = join(taskDir, "USER_REQUEST.md");
  const resPath = join(taskDir, "RESEARCH.md");
  if (!existsSync(urPath) || !existsSync(resPath)) {
    pi.sendMessage(
      { customType: "pp-code-reviews-error", content: "Cannot start code review: USER_REQUEST.md or RESEARCH.md is missing.", display: true },
      { deliverAs: "steer" },
    );
    return { spawned: 0, agentIds: [] };
  }

  const userRequest = readFileSync(urPath, "utf-8");
  const research = readFileSync(resPath, "utf-8");
  const synthesizedPlan = getLatestSynthesizedPlan(taskDir);
  if (!synthesizedPlan) {
    pi.sendMessage(
      { customType: "pp-code-reviews-error", content: "Cannot start code review: no synthesized plan found.", display: true },
      { deliverAs: "steer" },
    );
    return { spawned: 0, agentIds: [] };
  }

  const reviewsDir = join(taskDir, "code-reviews");
  if (!existsSync(reviewsDir)) {
    mkdirSync(reviewsDir, { recursive: true });
  }

  const timestamp = Math.floor(Date.now() / 1000);
  const enabledVariants = Object.entries(config.codeReviewers).filter(([, v]) => v.enabled);
  const agentIds: string[] = [];
  const results: Promise<void>[] = [];

  for (const [variant] of enabledVariants) {
    const outputPath = join(reviewsDir, `${timestamp}_${variant}_round-${round}.md`);
    const agent = createCodeReviewerAgent(variant, config, { userRequest, research, synthesizedPlan }, outputPath);

    registerAgentDefinitions(pi, [{ type: "code_reviewer", variant, ...agent }]);

    results.push(
      (async () => {
        try {
          const { id } = await spawnViaRpc(pi, `code_reviewer_${variant}`, "Begin code review.", {
            description: `Code reviewer (${variant})`,
          });
          agentIds.push(id);
          await waitForCompletion(pi, id);
        } catch (err: any) {
          pi.sendMessage(
            {
              customType: "pp-code-reviewer-error",
              content: `Code reviewer variant "${variant}" failed: ${err.message}`,
              display: true,
            },
            { deliverAs: "steer" },
          );
        }
      })(),
    );
  }

  await Promise.allSettled(results);

  const reviewFiles = existsSync(reviewsDir)
    ? readdirSync(reviewsDir).filter((f) => f.includes(`round-${round}`) && !f.includes("final"))
    : [];

  if (reviewFiles.length > 0) {
    pi.sendMessage(
      {
        customType: "pp-code-reviews-done",
        content: [
          `${reviewFiles.length} code reviewer(s) completed (round ${round}). Reviews in ${reviewsDir}:`,
          ...reviewFiles.map((f) => `  - ${f}`),
          "",
          "Read all reviews and synthesize them into a final review.",
        ].join("\n"),
        display: true,
      },
      { deliverAs: "steer" },
    );
  } else {
    pi.sendMessage(
      {
        customType: "pp-code-reviews-error",
        content: [
          `All code reviewer variants failed (round ${round}) — no reviews were produced.`,
          "You must review the implementation yourself and decide whether to approve or request changes.",
        ].join("\n"),
        display: true,
      },
      { deliverAs: "steer" },
    );
  }

  return { spawned: enabledVariants.length, agentIds };
}
