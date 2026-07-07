import { readFileSync, existsSync, mkdirSync, readdirSync, statSync } from "fs";
import { join } from "path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolvePreset, type PiPiConfig, type VariantConfig } from "../config.js";
import { registerAgentDefinitions, spawnViaRpc, waitForCompletion } from "../agents/registry.js";
import { createCodeReviewerAgent } from "../agents/code-reviewer.js";
import { getContextDirs, getLatestSynthesizedPlan, getArtifactManifest } from "../context.js";
import type { RepoInfo } from "../repo-utils.js";
import type { PhaseSend } from "../transition-controller.js";

function isEnabled(value: { enabled?: boolean } | undefined): boolean {
  return value?.enabled !== false;
}

export function reviewSystemPrompt(taskDir: string, pass: number, phase?: string, mode?: "guided" | "autonomous"): string {
  // Each phase writes/loads its review outputs in a distinct directory:
  // brainstorm -> brainstorm-reviews, plan -> plan-reviews, everything else
  // (implement/review) -> code-reviews. The apply_feedback prompt must point the
  // agent at the SAME directory the reviewers wrote to (see planning.ts /
  // context.ts), otherwise it synthesizes against the wrong (empty) directory.
  const reviewsDirName = phase === "brainstorm" ? "brainstorm-reviews" : phase === "plan" ? "plan-reviews" : "code-reviews";
  const reviewsDir = join(taskDir, reviewsDirName);
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
      "3. If changes are needed: update the content within existing sections of USER_REQUEST.md / RESEARCH.md, and add/update artifacts/ files as needed",
      "4. If reviewers found no actionable gaps (e.g. task already done, minor suggestions only): do NOT modify the files",
      "5. Ignore suggestions that don't affect downstream planning quality",
      "",
      "USER_REQUEST.md MUST keep exactly: # User Request, ## Problem, ## Constraints",
      "RESEARCH.md MUST keep exactly: ## Affected Code, ## Architecture Context, ## Constraints & Edge Cases, ## Open Questions (optional)",
      "Any other sections will fail validation.",
      "Use pp_write_state_file / pp_edit_state_file (NOT the generic write/edit) for these .pp state files — they keep the output compact and validate structure.",
    ].join("\n");
  }

  // A standalone review task's "review" phase has nothing to implement: the output
  // is the synthesized findings. So it must NOT get the "create a fix plan /
  // implement / run afterImplement" tail that implement-phase review uses. The user
  // publishes findings (as file comments and/or GitHub PR comments) via the /pp
  // "Publish" menu after synthesis — which consumes the ANCHORS: block below.
  if (phase === "review") {
    return [
      `[PI-PI — REVIEW CYCLE (pass ${pass})]`,
      "",
      "Reviewer outputs are ready.",
      `Read them from ${reviewsDir}/ and synthesize the findings.`,
      "",
      "You are a SYNTHESIZER: merge the reviewer outputs. Do NOT write your own review from scratch.",
      `- Do NOT create the ${reviewsDirName}/ directory yourself — the extension manages it.`,
      "- This is a standalone review: do NOT create a fix plan, implement fixes, run afterImplement commands, or commit.",
      "- Do NOT publish findings now (no source edits, no `gh`); the user triggers publishing from the /pp menu.",
      "",
      "# Your job (in this order):",
      `1. Read ALL reviewer outputs from ${reviewsDir}/`,
      `2. Synthesize into ${reviewsDir}/<unix-epoch-seconds>_final_pass-${pass}.md (prefix with the current Unix epoch seconds, e.g. \`date +%s\`, so the file orders chronologically)`,
      "3. Present the synthesis to the user",
      "",
      "In the synthesized final-review file you MUST include a machine-readable `ANCHORS:` block for the accepted findings — one line per finding in EXACTLY this format (a later publish step consumes these lines):",
      "ANCHORS:",
      "<relative/path/from/repo/root>:<line> — <one-line finding>",
      "Use the `ANCHORS:` blocks the reviewers emitted as the source of file:line — do NOT invent locations. Write `ANCHORS:` followed by `(none)` if there are no anchorable accepted findings.",
      "",
      "PRIVACY: phrase every finding as a self-contained observation about the code. Do NOT reference private or internal details, `the ticket`, issue trackers, or internal design docs — these findings are published as PR/file comments. Say what is wrong in the code, not that it violates a private document's goal.",
      // The Review Summary schema is delivered by the standardized closing block
      // (constraints.ts closingBlockInstruction, gated to phase==="review"), which is
      // always prepended to this prompt — so it is intentionally NOT repeated here.
    ].join("\n");
  }

  // In autonomous plan/implement the phase does NOT complete until the agent
  // re-calls pp_phase_complete: that is what finalizes the pass and advances the
  // phase. Telling it to "present to the user" and wait causes the plan phase to
  // stall after applying feedback. Guided mode keeps the user-facing behavior.
  const finalStep =
    mode === "autonomous"
      ? "3. Call pp_phase_complete again to finalize this review pass. The phase is NOT complete until you do — do NOT stop or wait for the user"
      : "3. Present the synthesis to the user";

  // In the plan phase the synthesized plan IS the reviewed artifact: re-review
  // and the phase transition both read only the LATEST `*synthesized*` file (see
  // getLatestSynthesizedPlan). So autonomous plan feedback must be folded into a
  // new synthesized plan, NOT a separate fix-plan file (which those readers
  // ignore). In the implement phase the synthesized plan is code guidance, so
  // the fix-plan/implement/afterImplement pattern is correct there.
  const tail =
    mode === "autonomous"
      ? phase === "plan"
        ? [
            "",
            "If the reviewers require changes:",
            `1. Fold the required changes into a NEW synthesized plan at ${plansDir}/<timestamp>_synthesized.md (re-review and the phase transition read only the latest \`*synthesized*\` plan, so the fixes MUST land there — do not write them to a separate fix-plan file)`,
            "2. Then call pp_phase_complete again — the extension will start a new review pass or advance the phase as appropriate. Do NOT wait for the user.",
          ]
        : [
            "",
            "If changes are needed:",
            `1. Create a fix plan at ${plansDir}/<timestamp>_<description>.md (do NOT modify the original synthesized plan)`,
            "2. Implement the fixes",
            "3. Run afterImplement commands",
            "4. Then call pp_phase_complete again — the extension will start a new review pass or advance the phase as appropriate. Do NOT wait for the user.",
          ]
      : [
          "",
          "If changes are needed:",
          `1. Create a fix plan at ${plansDir}/<timestamp>_<description>.md (do NOT modify the original synthesized plan)`,
          "2. Implement the fixes",
          "3. Run afterImplement commands",
          "4. A new review pass will begin",
        ];

  return [
    `[PI-PI — REVIEW CYCLE (pass ${pass})]`,
    "",
    "Reviewer outputs are ready.",
    `Read them from ${reviewsDir}/, synthesize feedback, and implement fixes if needed.`,
    "",
    "You are a SYNTHESIZER: merge the reviewer outputs. Do NOT write your own review from scratch.",
    `- Do NOT create the ${reviewsDirName}/ directory yourself — the extension manages it.`,
    "- Do NOT call plannotator_submit_plan.",
    "",
    "# Your job (in this order):",
    `1. Read ALL reviewer outputs from ${reviewsDir}/`,
    `2. Synthesize into ${reviewsDir}/<unix-epoch-seconds>_final_pass-${pass}.md (prefix with the current Unix epoch seconds, e.g. \`date +%s\`, so the file orders chronologically)`,
    finalStep,
    ...tail,
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
  send: PhaseSend,
  variants?: Record<string, VariantConfig>,
  repos: RepoInfo[] = [],
): Promise<{ spawned: number; agentIds: string[]; failedVariants: string[] }> {
  const urPath = join(taskDir, "USER_REQUEST.md");
  const resPath = join(taskDir, "RESEARCH.md");
  if (!existsSync(urPath) || !existsSync(resPath)) {
    send(
      { customType: "pp-code-reviews-error", content: "Cannot start code review: USER_REQUEST.md or RESEARCH.md is missing.", display: true },
      "context",
    );
    return { spawned: 0, agentIds: [], failedVariants: [] };
  }

  const userRequest = readFileSync(urPath, "utf-8");
  const research = readFileSync(resPath, "utf-8");
  // A standalone review task (phase "review") has no synthesized plan by design —
  // reviewers assess the diff against USER_REQUEST.md/RESEARCH.md instead. The
  // plan is only required where one legitimately exists (the implement phase).
  const synthesizedPlan = phase === "review" ? undefined : (getLatestSynthesizedPlan(taskDir) ?? undefined);
  if (phase !== "review" && !synthesizedPlan) {
    send(
      { customType: "pp-code-reviews-error", content: "Cannot start code review: no synthesized plan found.", display: true },
      "context",
    );
    return { spawned: 0, agentIds: [], failedVariants: [] };
  }

  const reviewsDir = join(taskDir, "code-reviews");
  if (!existsSync(reviewsDir)) {
    mkdirSync(reviewsDir, { recursive: true });
  }

  const timestamp = Math.floor(Date.now() / 1000);
  const reviewerVariants = variants ?? resolvePreset(config, "codeReviewers");
  const enabledVariants = Object.entries(reviewerVariants).filter(([, v]) => isEnabled(v));
  const contextDirs = getContextDirs(cwd, repos, config.general.loadExtraRepoConfigs);
  const agentIds: string[] = [];
  const failedVariants: string[] = [];
  const results: Promise<void>[] = [];

  for (const [variant] of enabledVariants) {
    const outputPath = join(reviewsDir, `${timestamp}_${variant}_round-${round}.md`);
    const reviewerPhase = phase === "review" ? "review" : "implement";
    const agent = createCodeReviewerAgent(
      variant,
      reviewerVariants,
      { userRequest, research, synthesizedPlan, manifest: getArtifactManifest(taskDir) },
      outputPath,
      contextDirs,
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
          send(
            {
              customType: "pp-code-reviewer-error",
              content: `Code reviewer variant "${variant}" failed: ${err.message}`,
              display: true,
            },
            "context",
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
    send(
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
      "context",
    );
  } else {
    send(
      {
        customType: "pp-code-reviews-error",
        content: [
          `All code reviewer variants failed (round ${round}) — no reviews were produced.`,
          "You must review the implementation yourself and decide whether to approve or request changes.",
        ].join("\n"),
        display: true,
      },
      "context",
    );
  }

  return { spawned: enabledVariants.length, agentIds, failedVariants };
}
