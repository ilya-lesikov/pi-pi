import { readFileSync, existsSync, mkdirSync, readdirSync } from "fs";
import { join } from "path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { PiPiConfig } from "../config.js";
import { registerAgentDefinitions, spawnViaRpc, waitForCompletion } from "../agents/registry.js";
import { createCodeReviewerAgent } from "../agents/code-reviewer.js";
import { getLatestSynthesizedPlan } from "../context.js";

export function reviewSystemPrompt(taskDir: string, round: number, usePlannotator: boolean): string {
  return [
    `[PI-PI — REVIEW PHASE (round ${round})]`,
    "",
    "Code reviewer subagents are analyzing the implementation.",
    "When their reviews appear in the reviews/ directory, read all of them.",
    "",
    "Your job:",
    "1. Read all reviewer outputs from reviews/",
    "2. Synthesize into reviews/<timestamp>_final_round-<N>.md",
    "3. Present the synthesis to the user",
    ...(usePlannotator ? ["4. Submit the review via plannotator_submit_plan for user review"] : []),
    "",
    "If changes are needed:",
    "1. Create a fix plan at plans/<timestamp>_<description>.md (do NOT modify the original synthesized plan)",
    "2. Implement the fixes",
    "3. Run afterImplement commands",
    "4. A new review round will begin",
    "",
    "If the user approves, call /pp:next to finish.",
  ].join("\n");
}

export async function spawnCodeReviewers(
  pi: ExtensionAPI,
  cwd: string,
  taskDir: string,
  taskId: string,
  config: PiPiConfig,
  round: number,
): Promise<void> {
  const urPath = join(taskDir, "USER_REQUEST.md");
  const resPath = join(taskDir, "RESEARCH.md");
  if (!existsSync(urPath) || !existsSync(resPath)) return;

  const userRequest = readFileSync(urPath, "utf-8");
  const research = readFileSync(resPath, "utf-8");
  const synthesizedPlan = getLatestSynthesizedPlan(taskDir);
  if (!synthesizedPlan) return;

  const reviewsDir = join(taskDir, "reviews");
  if (!existsSync(reviewsDir)) {
    mkdirSync(reviewsDir, { recursive: true });
  }

  const timestamp = Math.floor(Date.now() / 1000);
  const enabledVariants = Object.entries(config.codeReviewers).filter(([, v]) => v.enabled);
  const results: Promise<void>[] = [];

  for (const [variant] of enabledVariants) {
    const outputPath = join(reviewsDir, `${timestamp}_${variant}_round-${round}.md`);
    const agent = createCodeReviewerAgent(variant, config, { userRequest, research, synthesizedPlan }, outputPath);

    registerAgentDefinitions(pi, taskId, [{ type: "code_reviewer", variant, ...agent }]);

    results.push(
      (async () => {
        try {
          const { id } = await spawnViaRpc(pi, `pp_${taskId}_code_reviewer_${variant}`, agent.prompt, {
            description: `Code reviewer (${variant})`,
            model: agent.frontmatter.model,
            thinkingLevel: agent.frontmatter.thinking,
          });
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
}
