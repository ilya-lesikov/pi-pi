import { readFileSync, existsSync, mkdirSync, readdirSync, statSync } from "fs";
import { basename, join } from "path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolvePreset, type PiPiConfig, type VariantConfig } from "../config.js";
import { registerAgentDefinitions, spawnViaRpc, waitForCompletion } from "../agents/registry.js";
import { createPlannerAgent } from "../agents/planner.js";
import { createPlanReviewerAgent } from "../agents/plan-reviewer.js";
import { getContextDirs, getLatestSynthesizedPlan, getArtifactManifest } from "../context.js";
import type { RepoInfo } from "../repo-utils.js";
import { validatePlan } from "../validate-artifacts.js";
import { isReviewFileForRound, isReviewComplete } from "../review-files.js";
import { classifyPlanVariants, isPlanStub } from "../plan-files.js";
import type { TaskMode } from "../state.js";
import type { PhaseSend } from "../transition-controller.js";

function isEnabled(value: { enabled?: boolean } | undefined): boolean {
  return value?.enabled !== false;
}

export function planningSystemPrompt(taskDir: string, mode: TaskMode): string {
  const plansDir = join(taskDir, "plans");
  const contradictionRule =
    mode === "autonomous"
      ? "   If planner outputs CONTRADICT each other on a locked decision, resolve it by favoring USER_REQUEST.md, RECORD the contradiction and your chosen resolution in the plan, and proceed — do NOT stall waiting for the user (there is none)."
      : "   If planner outputs CONTRADICT each other on a locked decision, surface the contradiction to the user and let them decide — do NOT silently invent a compromise.";
  const synthesizeCompletionRule =
    mode === "autonomous"
      ? ""
      : "When you judge the plan synthesis complete, call pp_phase_complete — the extension opens the advance gate for the user to review and confirm. Do NOT instead ask the user to run /pp manually.";
  return [
    "[PI-PI — PLAN PHASE]",
    "",
    "If you need clarification, batch it early rather than interrupting mid-work. Avoid mid-flight questions; you run off the approved USER_REQUEST/RESEARCH/plan. A genuine blocker is the only reason to stop and ask.",
    "",
    "You are a SYNTHESIZER: you MERGE the planner outputs into one plan. Do NOT write your own plan from scratch.",
    "Planning subagents are working in parallel to create plans.",
    `They will write their outputs to ${plansDir}/. Wait for the notification that all planners completed.`,
    "",
    "- Do NOT create the plans/ directory yourself — the extension manages it.",
    "- Do NOT check the plans directory yourself — wait for the notification that the planners finished.",
    "- Do NOT read project source code directly — the planner outputs already contain the analysis.",
    "- Do NOT call plannotator_submit_plan.",
    "",
    "# Your job (in this order):",
    "1. Wait for the notification that the planners finished and lists the complete planner outputs — do NOT proceed before this",
    `2. Read the COMPLETE planner outputs from ${plansDir}/ — a file marked \`PLAN_STATUS: INCOMPLETE\` is an unfinished planner and must be treated as a gap, NOT as an input (an older plan carrying no PLAN_STATUS marker at all is a complete legacy plan — use it)`,
    "3. USER_REQUEST.md and RESEARCH.md are already provided in your context above — do NOT re-read them from disk",
    `4. Synthesize all plans into a single plan at ${plansDir}/<timestamp>_synthesized.md`,
    "5. Treat as LOCKED PREDICATES (do not re-litigate): the user's explicit constraints, chosen language/framework, and scope from USER_REQUEST.md. Discard any planner suggestion that violates them.",
    contradictionRule,
    "",
    "Plan format:",
    "- Start with # Plan",
    "- ## Scope: 2-4 lines — what changes, what doesn't, critical constraints",
    "- ## Checklist: each item is - [ ] <outcome> — Done when: <observable condition>",
    "  Each item = one independently verifiable outcome, right-sized to the smallest chunk worth verifying on its own. No code snippets or file-by-file instructions. Nest these INSIDE the Done-when condition (do not add sections or code): (a) a verification method — how the outcome is proven (test passes, diagnostics clean, command output); (b) for items meant for parallel delegation, the interface it consumes/produces (what earlier outcomes it depends on, what later ones depend on it); (c) NO unresolved items — an item that defers a decision instead of stating a concrete outcome is a plan failure; resolve it now (in any language: a placeholder such as 'TBD'/'TODO'/'decide later' is only an illustrative example of the deferral to avoid, not the literal thing being matched).",
    "- ## Pattern constraints: include this section whenever the task adds a type, function, parser, annotation, config key, enum, or any user-facing value. For each, name the CLOSEST EXISTING analog in the codebase (found by behavior, not filename) and the exact conventions the implementer MUST mirror: data shape (prefer one existing shape over inventing parallel/duplicated state), spelling/casing of user-facing values (match existing values — never invent a new casing), and parser/validation/error-handling shape. These are acceptance criteria, not suggestions. Omit the section only if the task adds none of the above.",
    "- ## Blockers: unresolved issues blocking implementation (omit if none)",
    "Write/update the synthesized plan with pp_write_state_file / pp_edit_state_file (NOT the generic write/edit) — they keep the output compact and validate structure.",
    "- No other top-level sections allowed",
    "- Describe outcomes, not code-level mechanics, EXCEPT in ## Pattern constraints where naming the concrete analog and conventions is required",
    ...(synthesizeCompletionRule ? ["", synthesizeCompletionRule] : []),
  ].join("\n");
}

export async function spawnPlanners(
  pi: ExtensionAPI,
  cwd: string,
  taskDir: string,
  taskId: string,
  config: PiPiConfig,
  send: PhaseSend,
  variants?: Record<string, VariantConfig>,
  repos: RepoInfo[] = [],
): Promise<{ spawned: number; agentIds: string[]; failedVariants: string[] }> {
  const urPath = join(taskDir, "USER_REQUEST.md");
  const resPath = join(taskDir, "RESEARCH.md");
  if (!existsSync(urPath) || !existsSync(resPath)) return { spawned: 0, agentIds: [], failedVariants: [] };

  const userRequest = readFileSync(urPath, "utf-8");
  const research = readFileSync(resPath, "utf-8");

  const plansDir = join(taskDir, "plans");
  if (!existsSync(plansDir)) {
    mkdirSync(plansDir, { recursive: true });
  }

  const timestamp = Math.floor(Date.now() / 1000);
  const plannerVariants = variants ?? resolvePreset(config, "planners");
  const enabledVariants = Object.entries(plannerVariants).filter(([, v]) => isEnabled(v));
  const contextDirs = getContextDirs(cwd, repos, config.general.loadExtraRepoConfigs);
  const agentIds: string[] = [];
  const failedVariants: string[] = [];
  const results: Promise<void>[] = [];

  for (const [variant] of enabledVariants) {
    const outputPath = join(plansDir, `${timestamp}_${variant}.md`);
    const agent = createPlannerAgent(variant, plannerVariants, { userRequest, research, manifest: getArtifactManifest(taskDir) }, outputPath, contextDirs, "plan", repos);

    registerAgentDefinitions(pi, [{ type: "planner", variant, ...agent }]);

    results.push(
      (async () => {
        try {
          const { id } = await spawnViaRpc(pi, `planner_${variant}`, "Begin planning.", {
            description: `Planner (${variant})`,
            validateCompletion: () => {
              if (!existsSync(outputPath) || statSync(outputPath).size === 0) {
                return `You finished without writing your plan file. Write your plan to: ${outputPath}`;
              }
              const content = readFileSync(outputPath, "utf-8");
              // Only the stub was ever written, so the planner never produced a
              // plan. Its structure errors would be noise — the actionable
              // problem is that the run did not finish.
              if (isPlanStub(content)) {
                return `You finished without writing your plan — only the PLAN_STATUS: INCOMPLETE stub is present. Write your plan to: ${outputPath}`;
              }
              const validation = validatePlan(content);
              if (!validation.ok) {
                return `Plan validation failed:\n${validation.errors.join("\n")}\n\nFix the plan at ${outputPath}`;
              }
            },
          });
          agentIds.push(id);
          await waitForCompletion(pi, id);

          if (existsSync(outputPath)) {
            const planContent = readFileSync(outputPath, "utf-8");
            const validation = validatePlan(planContent);
            if (!validation.ok) {
              send(
                {
                  customType: "pp-planner-error",
                  content: `Planner "${variant}" produced invalid plan (errors were shown to the agent but it did not fix them): ${validation.errors.join("; ")}`,
                  display: true,
                },
                "context",
              );
            }
          }
        } catch (err: any) {
          failedVariants.push(variant);
          send(
            {
              customType: "pp-planner-error",
              content: `Planner variant "${variant}" failed: ${err.message}`,
              display: true,
            },
            "context",
          );
        }
      })(),
    );
  }

  await Promise.allSettled(results);

  // Report only FINISHED plans: a stub-only variant is a gap to be aware of, not
  // an input for synthesis.
  const { completeFiles, incompleteVariants } = classifyPlanVariants(plansDir, enabledVariants.map(([name]) => name));
  if (completeFiles.length > 0) {
    send(
      {
        customType: "pp-planners-done",
        content: [
          `${completeFiles.length} planner(s) produced a complete plan in ${plansDir}:`,
          ...completeFiles.map((f) => `  - ${basename(f)}`),
          ...(incompleteVariants.length > 0
            ? ["", `Did NOT produce a complete plan (treat as gaps, do NOT synthesize from them): ${incompleteVariants.join(", ")}.`]
            : []),
          "",
          "Read the complete plans listed above and synthesize them into a single plan.",
        ].join("\n"),
        display: true,
      },
      "context",
    );
  } else {
    send(
      {
        customType: "pp-planners-error",
        content: [
          "All planner variants failed — no plan files were produced.",
          "You must create the plan yourself based on USER_REQUEST.md and RESEARCH.md.",
        ].join("\n"),
        display: true,
      },
      "context",
    );
  }

  return { spawned: enabledVariants.length, agentIds, failedVariants };
}

export async function spawnPlanReviewers(
  pi: ExtensionAPI,
  cwd: string,
  taskDir: string,
  taskId: string,
  config: PiPiConfig,
  pass: number,
  send: PhaseSend,
  variants?: Record<string, VariantConfig>,
  repos: RepoInfo[] = [],
): Promise<{ spawned: number; files: string[]; agentIds: string[]; failedVariants: string[] }> {
  const urPath = join(taskDir, "USER_REQUEST.md");
  const resPath = join(taskDir, "RESEARCH.md");
  if (!existsSync(urPath) || !existsSync(resPath)) {
    send(
      { customType: "pp-plan-reviews-error", content: "Cannot start plan review: USER_REQUEST.md or RESEARCH.md is missing.", display: true },
      "context",
    );
    return { spawned: 0, files: [], agentIds: [], failedVariants: [] };
  }

  const userRequest = readFileSync(urPath, "utf-8");
  const research = readFileSync(resPath, "utf-8");
  const synthesizedPlan = getLatestSynthesizedPlan(taskDir);
  if (!synthesizedPlan) {
    send(
      { customType: "pp-plan-reviews-error", content: "Cannot start plan review: no synthesized plan found.", display: true },
      "context",
    );
    return { spawned: 0, files: [], agentIds: [], failedVariants: [] };
  }

  const planReviewsDir = join(taskDir, "plan-reviews");
  if (!existsSync(planReviewsDir)) {
    mkdirSync(planReviewsDir, { recursive: true });
  }

  const timestamp = Math.floor(Date.now() / 1000);
  const reviewerVariants = variants ?? resolvePreset(config, "planReviewers");
  const enabledVariants = Object.entries(reviewerVariants).filter(([, v]) => isEnabled(v));
  const contextDirs = getContextDirs(cwd, repos, config.general.loadExtraRepoConfigs);
  const reviewFiles: string[] = [];
  const agentIds: string[] = [];
  const failedVariants: string[] = [];

  const results: Promise<void>[] = [];
  for (const [variant] of enabledVariants) {
    const outputPath = join(planReviewsDir, `${timestamp}_${variant}_round-${pass}.md`);
    reviewFiles.push(outputPath);

    const agent = createPlanReviewerAgent(
      variant,
      reviewerVariants,
      { userRequest, research, synthesizedPlan, manifest: getArtifactManifest(taskDir) },
      outputPath,
      contextDirs,
      "plan",
      repos,
    );

    registerAgentDefinitions(pi, [{ type: "plan_reviewer", variant, ...agent }]);

    results.push(
      (async () => {
        try {
          const { id } = await spawnViaRpc(pi, `plan_reviewer_${variant}`, "Begin plan review.", {
            description: `Plan reviewer (${variant})`,
            validateCompletion: () => {
              if (!existsSync(outputPath) || statSync(outputPath).size === 0) {
                return `You finished without writing your review file. Write your review to: ${outputPath}`;
              }
              if (!isReviewComplete(readFileSync(outputPath, "utf-8"))) {
                return `Your review file is still the INCOMPLETE stub — you never wrote your findings. Write your full review to ${outputPath}, ending with the line REVIEW_STATUS: COMPLETE.`;
              }
            },
          });
          agentIds.push(id);
          await waitForCompletion(pi, id);
        } catch (err: any) {
          failedVariants.push(variant);
          send(
            {
              customType: "pp-plan-reviewer-error",
              content: `Plan reviewer variant "${variant}" failed: ${err.message}`,
              display: true,
            },
            "context",
          );
        }
      })(),
    );
  }

  await Promise.allSettled(results);

  const actualReviewFiles = existsSync(planReviewsDir)
    ? readdirSync(planReviewsDir).filter((f) => f.startsWith(`${timestamp}`) && isReviewFileForRound(f, pass))
    : [];

  if (actualReviewFiles.length > 0) {
    send(
      {
          customType: "pp-plan-reviews-done",
          content: [
          `${actualReviewFiles.length} plan reviewer(s) completed. Reviews in ${planReviewsDir}:`,
          ...actualReviewFiles.map((f) => `  - ${f}`),
          "",
          "Read all plan reviews and incorporate feedback into the synthesized plan if needed.",
        ].join("\n"),
        display: true,
      },
      "context",
    );
  } else if (enabledVariants.length > 0) {
    send(
      {
        customType: "pp-plan-reviews-error",
        content: "All plan reviewer variants failed — no reviews were produced. Proceeding without plan review.",
        display: true,
      },
      "context",
    );
  }

  return { spawned: enabledVariants.length, files: reviewFiles, agentIds, failedVariants };
}
