import { readFileSync, existsSync, mkdirSync, readdirSync, statSync } from "fs";
import { join } from "path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolvePreset, type PiPiConfig, type VariantConfig } from "../config.js";
import { registerAgentDefinitions, spawnViaRpc, waitForCompletion } from "../agents/registry.js";
import { createBrainstormReviewerAgent } from "../agents/brainstorm-reviewer.js";
import { getContextDirs, getArtifactManifest } from "../context.js";
import type { RepoInfo } from "../repo-utils.js";
import { isReviewFileForRound } from "../review-files.js";
import type { PhaseSend } from "../transition-controller.js";

function isEnabled(value: { enabled?: boolean } | undefined): boolean {
  return value?.enabled !== false;
}

// The streamlined interactive-phase flow (design-decisions §3b). driverFamily is
// the phase's own orchestrator model family; defaultAdvisor is the family-differing
// advisor to consult by default (Claude-driven → a GPT-family advisor; GPT-driven
// → a Claude-family advisor). Advisors are model-named pool subagents; pick one
// from the roster in the delegation guidance.
//
// The clarify step is caller-selected. "socratic" (brainstorm) elicits design intent
// one question at a time with a second push, because the first answer to a design
// question is usually the polished/surface one. "scope" (review-task intake) is
// factual up-front scoping (which repo/branch/PR/range), not design elicitation, so
// it deliberately keeps the batch-it-up-front behavior.
export function interactiveFlowBlock(
  driverFamily: string,
  defaultAdvisor: string,
  opts: { clarify?: "socratic" | "scope" } = {},
): string {
  const { clarify = "socratic" } = opts;
  const clarifyStep =
    clarify === "scope"
      ? "1. CLARIFY SCOPE UP-FRONT: if what to review is ambiguous (which repo/branch/PR/commit-range, what to focus on), ask up front before diving in. This is factual scoping, not design elicitation — ask them up front in quick succession (still one focused question per ask_user call, never bundled into one prompt) rather than dripping them out across the work. If the scope is clear, skip straight to step 2."
      : "1. CLARIFY ONE AT A TIME: if the request is ambiguous, ask ONE focused question, then WAIT for the answer before asking the next — do NOT batch a list. The first answer to a design question is usually the polished/surface one; push once more on it (\"what would that actually look like / what breaks if…\") to reach the real answer before moving on. Skip any question the request already answers. If running autonomously with no user to ask, do NOT block: make the strongest-supported assumption and record it via the assumptions rule in your constraints (artifacts/ASSUMPTIONS.md) instead of asking.";
  const workStep = "2. WORK AUTONOMOUSLY: research, explore, and design without stopping to ask. Delegate to subagents (parallel explores for broad searches). Do NOT interrupt mid-flow with questions — collect uncertainties for step 4 instead. Only a genuine blocker (you cannot proceed at all) justifies an ask here. The one-at-a-time push above is for the clarify stage, not license to interrupt mid-work.";
  const presentStep = "6. PRESENT RESULTS: end with a structured summary (what you found, the decisions, the recommended direction) and hand back with the standard closing block.";
  return [
    "# Flow (minimize interruptions):",
    clarifyStep,
    workStep,
    `3. CONSULT AN ADVISOR: before presenting, get an independent second opinion from an advisor whose model family differs from yours. You run on ${driverFamily}, so default to ${defaultAdvisor}. Escalate to more advisors for hard or high-stakes calls.`,
    "4. CLARIFY AT THE END: surface any remaining decisions as focused asks — one at a time. Don't bury unresolved questions inside an approval prompt or the summary.",
    "5. APPROVE COMMITTED SPECIFICS: before finalizing, when your output commits to concrete, costly-to-reverse or opinion-heavy choices — exact wording, structure, naming, default values, or interface signatures — show the ACTUAL proposed text/values inline in your message, then ask for explicit approval. Don't silently invent and bury them.",
    presentStep,
  ].join("\n");
}

export function brainstormSystemPrompt(taskDescription: string, taskDir: string, cwd: string): string {
  const registerReposInstruction = `First, register all git repositories you'll work in using pp_register_repo (including the root: ${cwd}). For each, determine the base branch by examining the current branch and remote tracking.`;

  return [
    "[PI-PI — BRAINSTORM PHASE]",
    `Task: ${taskDescription}`,
    "",
    registerReposInstruction,
    "",
    "This is a clarify + research + DESIGN phase. Your job is to produce USER_REQUEST.md and RESEARCH.md — complete enough that",
    "downstream agents can work without re-exploring the codebase or re-interviewing the user. That means not just describing what",
    "exists, but exploring the design space: weigh the viable approaches and their tradeoffs so the plan phase inherits a clear",
    "direction rather than an open-ended problem.",
    "",
    interactiveFlowBlock("Claude", "a GPT-family advisor"),
    "",
    "# Steps:",
    "1. Clarify requirements with the user if anything is ambiguous",
    "2. Delegate research to subagents where useful (see the delegation guidance in your system prompt) — spawn multiple explores in parallel for broad searches",
    "3. Use tools to understand code structure:",
    "   - cbm_search: natural-language search across all symbols",
    "   - cbm_search_code: graph-augmented grep (deduplicates into functions)",
    "   - lsp documentSymbol, goToDefinition, findReferences, goToImplementation, hover",
    "   - cbm_trace: trace call chains for dependency understanding",
    "   - ast_search: find structural patterns across the codebase",
    "4. Explore design options: identify 2-3 viable approaches, weigh their tradeoffs, and lead with a recommended direction + why (capture the reasoning in RESEARCH.md / an artifact). If the task spans multiple independent subsystems, triage that up front and decompose it rather than treating it as one blob. Do NOT dismiss anything as 'too simple to need design' — unexamined assumptions in 'simple' work cause the most wasted effort. When you give a judgment, take a position and state what evidence would change it; do NOT hedge without landing anywhere or offer empty validation (illustrative anti-patterns, any language: 'that could work', 'it depends' with no position).",
    "5. Ask the user follow-up questions as needed",
    "6. Actively drive every Open Question to resolution — chase down answers via research or by asking the user; the Open Questions section should be empty (or every entry marked DECIDED:/ASSUMED: with rationale) before you hand off, not a passive backlog. This is the LAST interactive phase: if the task continues in autonomous mode, the downstream plan/implement phases cannot ask the user anything, so a deferred question becomes an unanswered one. Resolve or explicitly ASSUME each now — do NOT defer to the plan phase.",
    "7. Write findings into RESEARCH.md as results come back — don't wait for all subagents",
    "8. Keep USER_REQUEST.md current: update it whenever the user's request changes or clarifies, so it reflects what the user actually wants — don't write it once and leave it stale",
    "",
    "Produce two files:",
    `- ${taskDir}/USER_REQUEST.md — MUST follow this exact structure:`,
    "  # User Request",
    "  <1-3 sentence distillation of what the user wants>",
    "  ## Problem",
    "  <What's broken / what's missing, in the user's words. Issue link if provided.>",
    "  ## Constraints",
    "  <Boundaries the user explicitly stated. Only user-stated info, no agent findings.>",
    `- ${taskDir}/RESEARCH.md — MUST follow this exact structure:`,
    "  ## Affected Code",
    "  <file:symbol — one-line role, per line>",
    "  ## Architecture Context",
    "  <Dense bullets. How affected pieces connect. Sub-group by subsystem for complex tasks.>",
    "  ## Constraints & Edge Cases",
    "  - MUST: <hard requirements discovered from code>",
    "  - RISK: <things that could break>",
    "  ## Open Questions",
    "  <Unresolved items needing user input. Drive these to resolution before advancing — omit the section only when genuinely none remain.>",
    "",
    "These files are validated programmatically. Missing sections or unexpected sections will be rejected.",
    "Use pp_write_state_file / pp_edit_state_file (NOT the generic write/edit) for .pp state files — they keep the output compact and validate structure.",
    "",
    "# Optional: focused analysis artifacts",
    `You may also write additional analysis files to ${taskDir}/artifacts/<name>.md`,
    "for deep dives on specific topics (e.g. architecture analysis, API comparison, design-option/tradeoff analysis, risk assessment).",
    "Each artifact must start with # <Title>. Content is freeform. These are reviewed alongside USER_REQUEST.md and RESEARCH.md.",
    "Do NOT duplicate content already in RESEARCH.md — artifacts are for supplementary deep dives.",
  ].join("\n");
}

export async function spawnBrainstormReviewers(
  pi: ExtensionAPI,
  cwd: string,
  taskDir: string,
  taskId: string,
  config: PiPiConfig,
  round: number,
  send: PhaseSend,
  variants?: Record<string, VariantConfig>,
  repos: RepoInfo[] = [],
): Promise<{ spawned: number; files: string[]; agentIds: string[]; failedVariants: string[] }> {
  const urPath = join(taskDir, "USER_REQUEST.md");
  const resPath = join(taskDir, "RESEARCH.md");
  if (!existsSync(urPath) || !existsSync(resPath)) {
    send(
      { customType: "pp-brainstorm-reviews-error", content: "Cannot start artifact review: USER_REQUEST.md or RESEARCH.md is missing.", display: true },
      "context",
    );
    return { spawned: 0, files: [], agentIds: [], failedVariants: [] };
  }

  const userRequest = readFileSync(urPath, "utf-8");
  const research = readFileSync(resPath, "utf-8");

  const artifactsDir = join(taskDir, "artifacts");
  const artifacts: { name: string; content: string }[] = [];
  if (existsSync(artifactsDir)) {
    for (const f of readdirSync(artifactsDir).filter((f) => f.endsWith(".md")).sort()) {
      artifacts.push({ name: `artifacts/${f}`, content: readFileSync(join(artifactsDir, f), "utf-8") });
    }
  }

  const reviewsDir = join(taskDir, "brainstorm-reviews");
  if (!existsSync(reviewsDir)) {
    mkdirSync(reviewsDir, { recursive: true });
  }

  const timestamp = Math.floor(Date.now() / 1000);
  const reviewerVariants = variants ?? resolvePreset(config, "brainstormReviewers");
  const enabledVariants = Object.entries(reviewerVariants).filter(([, v]) => isEnabled(v));
  const contextDirs = getContextDirs(cwd, repos, config.general.loadExtraRepoConfigs);
  const reviewFiles: string[] = [];
  const agentIds: string[] = [];
  const failedVariants: string[] = [];
  const results: Promise<void>[] = [];

  for (const [variant] of enabledVariants) {
    const outputPath = join(reviewsDir, `${timestamp}_${variant}_round-${round}.md`);
    reviewFiles.push(outputPath);
    const agent = createBrainstormReviewerAgent(
      variant,
      reviewerVariants,
      { userRequest, research, artifacts: artifacts.length > 0 ? artifacts : undefined, manifest: getArtifactManifest(taskDir) },
      outputPath,
      contextDirs,
      "brainstorm",
      repos,
    );

    registerAgentDefinitions(pi, [{ type: "brainstorm_reviewer", variant, ...agent }]);

    results.push(
      (async () => {
        try {
          const { id } = await spawnViaRpc(pi, `brainstorm_reviewer_${variant}`, "Begin brainstorm artifact review.", {
            description: `Brainstorm reviewer (${variant})`,
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
              customType: "pp-brainstorm-reviewer-error",
              content: `Brainstorm reviewer variant "${variant}" failed: ${err.message}`,
              display: true,
            },
            "context",
          );
        }
      })(),
    );
  }

  await Promise.allSettled(results);

  const reviewOutputFiles = existsSync(reviewsDir)
    ? readdirSync(reviewsDir).filter((f) => isReviewFileForRound(f, round))
    : [];

  if (reviewOutputFiles.length > 0) {
    send(
      {
        customType: "pp-brainstorm-reviews-done",
        content: [
          `${reviewOutputFiles.length} brainstorm reviewer(s) completed (round ${round}). Reviews in ${reviewsDir}:`,
          ...reviewOutputFiles.map((f) => `  - ${f}`),
          "",
          "Read all reviews and update USER_REQUEST.md, RESEARCH.md, and any artifacts/ files if needed.",
        ].join("\n"),
        display: true,
      },
      "context",
    );
  } else if (enabledVariants.length > 0) {
    send(
      {
        customType: "pp-brainstorm-reviews-error",
        content: [
          `All brainstorm reviewer variants failed (round ${round}) — no reviews were produced.`,
          "Proceeding without automatic brainstorm review.",
        ].join("\n"),
        display: true,
      },
      "context",
    );
  }

  return { spawned: enabledVariants.length, files: reviewFiles, agentIds, failedVariants };
}
