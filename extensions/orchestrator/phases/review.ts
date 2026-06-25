import { readFileSync, existsSync, mkdirSync, readdirSync, statSync } from "fs";
import { join } from "path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolvePreset, type PiPiConfig, type VariantConfig } from "../config.js";
import { registerAgentDefinitions, spawnViaRpc, waitForCompletion } from "../agents/registry.js";
import { createCodeReviewerAgent } from "../agents/code-reviewer.js";
import { getLatestSynthesizedPlan } from "../context.js";
import type { RepoInfo } from "../repo-utils.js";

export function reviewSystemPrompt(taskDir: string, pass: number, phase?: string): string {
  const reviewsDir = phase === "brainstorm" ? join(taskDir, "brainstorm-reviews") : join(taskDir, "code-reviews");
  const plansDir = join(taskDir, "plans");

  if (phase === "brainstorm") {
    return [
      `[PI-PI — BRAINSTORM REVIEW CYCLE (pass ${pass})]`,
      "",
      "Brainstorm reviewer outputs are ready.",
      `Read them from ${reviewsDir}/.`,
      "",
      "# FORBIDDEN:",
      "- Do NOT modify project source code",
      "- Do NOT write your own review from scratch",
      "- Do NOT add, rename, or remove sections in USER_REQUEST.md or RESEARCH.md",
      "- Do NOT invent new headings (e.g. '## Current State', '## Critical Finding')",
      "",
      "# Your job:",
      `1. Read ALL reviewer outputs from ${reviewsDir}/`,
      "2. Identify valid gaps and inaccuracies that would block planning",
      "3. If changes are needed: update ONLY the content within existing sections of USER_REQUEST.md / RESEARCH.md",
      "4. If reviewers found no actionable gaps (e.g. task already done, minor suggestions only): do NOT modify the files",
      "5. Ignore suggestions that don't affect downstream planning quality",
      "",
      "USER_REQUEST.md MUST keep exactly: # User Request, ## Problem, ## Constraints",
      "RESEARCH.md MUST keep exactly: ## Affected Code, ## Architecture Context, ## Constraints & Edge Cases, ## Open Questions (optional)",
      "Any other sections will fail validation.",
      "",
      "When done (or no changes needed), call pp_phase_complete with a brief summary.",
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
    "- Do NOT call plannotator_submit_plan — code review is handled by the user via /pp menu.",
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
  phase: string,
  variants?: Record<string, VariantConfig>,
  repos: RepoInfo[] = [],
): Promise<{ spawned: number; agentIds: string[]; failedVariants: string[] }> {
  const urPath = join(taskDir, "USER_REQUEST.md");
  const resPath = join(taskDir, "RESEARCH.md");
  if (!existsSync(urPath) || !existsSync(resPath)) {
    pi.sendMessage(
      { customType: "pp-code-reviews-error", content: "Cannot start code review: USER_REQUEST.md or RESEARCH.md is missing.", display: true },
      { deliverAs: "steer" },
    );
    return { spawned: 0, agentIds: [], failedVariants: [] };
  }

  const userRequest = readFileSync(urPath, "utf-8");
  const research = readFileSync(resPath, "utf-8");
  const synthesizedPlan = getLatestSynthesizedPlan(taskDir);
  if (!synthesizedPlan) {
    pi.sendMessage(
      { customType: "pp-code-reviews-error", content: "Cannot start code review: no synthesized plan found.", display: true },
      { deliverAs: "steer" },
    );
    return { spawned: 0, agentIds: [], failedVariants: [] };
  }

  const reviewsDir = join(taskDir, "code-reviews");
  if (!existsSync(reviewsDir)) {
    mkdirSync(reviewsDir, { recursive: true });
  }

  const timestamp = Math.floor(Date.now() / 1000);
  const reviewerVariants = variants ?? resolvePreset(config, "codeReviewers");
  const enabledVariants = Object.entries(reviewerVariants).filter(([, v]) => v.enabled);
  const agentIds: string[] = [];
  const failedVariants: string[] = [];
  const results: Promise<void>[] = [];

  for (const [variant] of enabledVariants) {
    const outputPath = join(reviewsDir, `${timestamp}_${variant}_round-${round}.md`);
    const reviewerPhase = phase === "review" ? "review" : "implement";
    const agent = createCodeReviewerAgent(
      variant,
      reviewerVariants,
      { userRequest, research, synthesizedPlan },
      outputPath,
      cwd,
      reviewerPhase,
      repos,
    );

    registerAgentDefinitions(pi, [{ type: "code_reviewer", variant, ...agent }]);

    results.push(
      (async () => {
        try {
          const { id } = await spawnViaRpc(pi, `code_reviewer_${variant}`, "Begin code review.", {
            description: `Code reviewer (${variant})`,
            validateCompletion: () => {
              if (!existsSync(outputPath) || statSync(outputPath).size === 0) {
                return `You finished without writing your review file. Write your review to: ${outputPath}`;
              }
            },
          });
          agentIds.push(id);
          await waitForCompletion(pi, id);
        } catch (err: any) {
          failedVariants.push(variant);
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

  return { spawned: enabledVariants.length, agentIds, failedVariants };
}
