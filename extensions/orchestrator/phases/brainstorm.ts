import { readFileSync, existsSync, mkdirSync, readdirSync, statSync } from "fs";
import { join } from "path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolvePreset, type PiPiConfig, type VariantConfig } from "../config.js";
import { registerAgentDefinitions, spawnViaRpc, waitForCompletion } from "../agents/registry.js";
import { createBrainstormReviewerAgent } from "../agents/brainstorm-reviewer.js";
import { getContextDirs, getArtifactManifest } from "../context.js";
import type { RepoInfo } from "../repo-utils.js";
import type { TaskType } from "../state.js";
import { isReviewFileForRound } from "../review-files.js";
import type { PhaseSend } from "../transition-controller.js";

function isEnabled(value: { enabled?: boolean } | undefined): boolean {
  return value?.enabled !== false;
}

// The streamlined interactive-phase flow (design-decisions §3b). driverFamily is
// the phase's own orchestrator model family; defaultAdvisor is the family-differing
// advisor to consult by default (Claude-driven → advisor2 gpt; GPT-driven → advisor opus).
export function interactiveFlowBlock(driverFamily: string, defaultAdvisor: string): string {
  return [
    "# Flow (minimize interruptions):",
    "1. CLARIFY UP-FRONT: if the request is ambiguous, ask your clarifying question(s) now, at the very start — batch them. If it's clear, skip straight to step 2.",
    "2. WORK AUTONOMOUSLY: research, explore, and design without stopping to ask. Delegate to subagents (parallel explores for broad searches). Do NOT interrupt mid-flow with questions — collect uncertainties for step 4 instead. Only a genuine blocker (you cannot proceed at all) justifies an ask here.",
    `3. CONSULT AN ADVISOR: before presenting, get an independent second opinion from an advisor whose model family differs from yours. You run on ${driverFamily}, so default to ${defaultAdvisor}. Escalate to a second/third advisor for hard or high-stakes calls.`,
    "4. CLARIFY AT THE END: surface any remaining decisions as focused asks — one at a time.",
    "5. APPROVE COMMITTED SPECIFICS: before finalizing, when your output commits to concrete, costly-to-reverse or opinion-heavy choices — exact wording, structure, naming, default values, or interface signatures — show the ACTUAL proposed text/values inline in your message, then ask for explicit approval. Don't silently invent and bury them.",
    "6. PRESENT RESULTS: end with a structured summary (what you found, the decisions, the recommended direction) and hand back with the standard closing block.",
  ].join("\n");
}

export function brainstormSystemPrompt(taskType: TaskType, taskDescription: string, taskDir: string, cwd: string): string {
  const registerReposInstruction = `First, register all git repositories you'll work in using pp_register_repo (including the root: ${cwd}). For each, determine the base branch by examining the current branch and remote tracking.`;
  if (taskType === "debug") {
    return [
      "[PI-PI — DEBUG PHASE]",
      `Problem: ${taskDescription}`,
      "",
      registerReposInstruction,
      "",
    "Read-only diagnosis mode. You MAY use write/edit for diagnosis only (repro/test/analysis files) — never to implement the actual fix or feature.",
      "",
      interactiveFlowBlock("GPT", "advisor (opus)"),
      "",
    "# Your job:",
    "1. Clarify the problem with the user if needed",
    "2. Delegate research to subagents where useful (see the delegation guidance in your system prompt), and use bash to run commands, check logs, reproduce issues",
    "3. Use tools to trace the bug:",
    "   - cbm_search/cbm_search_code: find relevant code by concept or text",
    "   - lsp goToDefinition, findReferences, hover: precise navigation and type info",
    "   - lsp goToImplementation: check interface implementors",
    "   - lsp diagnostics: find type errors",
    "   - cbm_trace: trace call chains to/from suspect functions",
    "   - ast_search: find structural patterns (e.g. error handling, goroutines)",
      "",
      "Produce two files:",
      `- ${taskDir}/USER_REQUEST.md — the fix request. MUST follow this exact structure:`,
      "  # User Request",
      "  <1-3 sentence distillation of the fix needed>",
      "  ## Problem",
      "  <What's broken, from the user's perspective / your diagnosis>",
      "  ## Constraints",
      "  <User-stated boundaries or critical constraints discovered during diagnosis>",
      `- ${taskDir}/RESEARCH.md — MUST follow this exact structure:`,
      "  ## Affected Code",
      "  <file:symbol — one-line role, per line>",
      "  ## Architecture Context",
      "  <Dense bullets. How affected pieces connect. Sub-group by subsystem for complex tasks.>",
      "  ## Constraints & Edge Cases",
      "  - MUST: <hard requirements discovered from code>",
      "  - RISK: <things that could break>",
      "  ## Open Questions",
      "  <Unresolved items needing user input. Omit section if none.>",
      "",
      "This is the LAST interactive phase. If the task continues in autonomous mode, the downstream plan/implement phases cannot ask the user anything — so resolve every Open Question now (answer it, or mark it DECIDED:/ASSUMED: with rationale). Do NOT defer questions to the plan phase.",
      "These files are validated programmatically. Missing sections or unexpected sections will be rejected.",
      "Use pp_write_state_file / pp_edit_state_file (NOT the generic write/edit) for .pp state files — they keep the output compact and validate structure.",
      "",
      "# Optional: focused analysis artifacts",
      `You may also write additional analysis files to ${taskDir}/artifacts/<name>.md`,
      "for deep dives on specific topics (e.g. architecture analysis, API comparison, risk assessment).",
      "Each artifact must start with # <Title>. Content is freeform. These are reviewed alongside USER_REQUEST.md and RESEARCH.md.",
      "Do NOT duplicate content already in RESEARCH.md — artifacts are for supplementary deep dives.",
      "",
      "Keep USER_REQUEST.md current: update it whenever the user's request changes or clarifies, so it never goes stale.",
    ].join("\n");
  }

  if (taskType === "brainstorm") {
    return [
      "[PI-PI — BRAINSTORM]",
      `Topic: ${taskDescription}`,
      "",
      registerReposInstruction,
      "",
      "# This is a conversation, not a task.",
      "Your primary job is to TALK WITH THE USER. Explore ideas, analyze tradeoffs, answer questions, discuss approaches.",
      "Do NOT rush to produce artifacts or finish. Stay in the conversation until the user is satisfied.",
      "",
      "# Flow (minimize interruptions — the streamlined flow, adapted to conversation):",
      "1. CLARIFY UP-FRONT: if the topic is ambiguous, ask your clarifying question(s) at the very start — batch them into one focused round rather than dripping them out.",
      "2. WORK AUTONOMOUSLY IN THE MIDDLE: once the topic is clear, research/explore/design without stopping to ask. Delegate to subagents (parallel explores for broad searches) and use tools directly for quick lookups. Do NOT interrupt with piecemeal mid-flow questions — collect uncertainties and raise them together at a natural checkpoint.",
      "3. CONSULT AN ADVISOR: before landing on a recommendation, get an independent second opinion from an advisor whose model family differs from yours. You run on Claude, so default to advisor2 (gpt). Escalate to a second/third advisor for hard or high-stakes calls.",
      "4. APPROVE COMMITTED SPECIFICS: when you commit to concrete, costly-to-reverse or opinion-heavy choices — exact wording, structure, naming, default values, or interface signatures — show the ACTUAL proposed text/values inline, then get explicit approval. Don't silently invent and bury them.",
      "5. PRESENT RESULTS: give conclusions as a clear, structured summary (findings, decisions, recommended direction) — don't just dump raw results.",
      "This is still a conversation: the user drives it and may steer at any time. The flow shapes HOW you work between their messages — it does not forbid responding to what they say.",
      "",
      "# How to work:",
      "- Discuss the topic with the user. Propose approaches. Analyze tradeoffs.",
      "- Delegate research to subagents where useful (see the delegation guidance in your system prompt).",
      "- Use tools directly for quick lookups (cbm_search, lsp, ast_search, grep, etc.)",
      "",
      "# Optional artifacts (only when the conversation naturally produces them):",
      "If the discussion leads to a clear action plan or the user asks you to capture conclusions,",
      "write them to:",
      `- ${taskDir}/USER_REQUEST.md — MUST use structure: # User Request, ## Problem, ## Constraints`,
      `- ${taskDir}/RESEARCH.md — MUST use structure: ## Affected Code, ## Architecture Context, ## Constraints & Edge Cases, ## Open Questions (optional)`,
      "These files are validated. Missing or unexpected sections will be rejected.",
      "Do NOT create these files preemptively. Only write them when there's substance to capture.",
      "Once USER_REQUEST.md exists, keep it current: update it whenever the user's request changes or clarifies, so it never goes stale.",
      "",
      "# Optional: focused analysis artifacts",
      `You may also write additional analysis files to ${taskDir}/artifacts/<name>.md`,
      "for deep dives on specific topics (e.g. architecture analysis, API comparison, risk assessment).",
      "Each artifact must start with # <Title>. Content is freeform. These are reviewed alongside USER_REQUEST.md and RESEARCH.md.",
      "Do NOT duplicate content already in RESEARCH.md — artifacts are for supplementary deep dives.",
    ].join("\n");
  }

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
    interactiveFlowBlock("Claude", "advisor2 (gpt)"),
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
    "4. Explore design options: identify the viable approaches, weigh their tradeoffs, and land on a recommended direction (capture the reasoning in RESEARCH.md / an artifact)",
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
