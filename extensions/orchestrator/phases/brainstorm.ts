import { readFileSync, existsSync, mkdirSync, readdirSync, statSync } from "fs";
import { join } from "path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { PiPiConfig } from "../config.js";
import { registerAgentDefinitions, spawnViaRpc, waitForCompletion } from "../agents/registry.js";
import { createBrainstormReviewerAgent } from "../agents/brainstorm-reviewer.js";
import type { TaskType } from "../state.js";

export function brainstormSystemPrompt(taskType: TaskType, taskDescription: string, taskDir: string): string {
  if (taskType === "debug") {
    return [
      "[PI-PI — DEBUG PHASE]",
      `Problem: ${taskDescription}`,
      "",
    "Read-only diagnosis mode.",
    "",
    "# FORBIDDEN — do NOT do any of these:",
    "- Do NOT modify project source code (no write or edit tools on project files)",
    "- Do NOT create or modify any files outside the task directory",
    "- Do NOT implement fixes — only diagnose and recommend",
    "- If the user asks you to implement a fix or start coding — call pp_phase_complete instead. It will offer \"Implement a fix\" as an option. Do NOT implement directly in this session.",
    "",
    "# Your job:",
    "1. Clarify the problem with the user if needed",
    "2. Spawn subagents for research (subagent_type is REQUIRED — calls without it are rejected):",
    '   - Agent(subagent_type="Explore", ...) — codebase research. Prefer this for most lookups.',
    '   - Agent(subagent_type="Librarian", ...) — external docs, library APIs, web research.',
    '   - Agent(subagent_type="Task", ...) — only when you need a subtask that writes files or runs complex multi-step commands.',
    "   Explore is fast and cheap. Use it liberally for codebase questions. Spawn multiple in parallel.",
    "3. Use bash to run commands, check logs, reproduce issues",
    "4. Use tools to trace the bug:",
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
      "These files are validated programmatically. Missing sections or unexpected sections will be rejected.",
      "",
      "# Optional: focused analysis artifacts",
      `You may also write additional analysis files to ${taskDir}/artifacts/<name>.md`,
      "for deep dives on specific topics (e.g. architecture analysis, API comparison, risk assessment).",
      "Each artifact must start with # <Title>. Content is freeform. These are reviewed alongside USER_REQUEST.md and RESEARCH.md.",
      "Do NOT duplicate content already in RESEARCH.md — artifacts are for supplementary deep dives.",
      "",
      "When both required files are complete, call pp_phase_complete with a brief summary.",
    ].join("\n");
  }

  if (taskType === "brainstorm") {
    return [
      "[PI-PI — BRAINSTORM]",
      `Topic: ${taskDescription}`,
      "",
      "# This is a conversation, not a task.",
      "Your primary job is to TALK WITH THE USER. Explore ideas, analyze tradeoffs, answer questions, discuss approaches.",
      "Do NOT rush to produce artifacts or finish. Stay in the conversation until the user is satisfied.",
      "",
      "# How to work:",
      "- Discuss the topic with the user. Ask clarifying questions. Propose approaches. Analyze tradeoffs.",
    "- Spawn subagents for research (subagent_type is REQUIRED — calls without it are rejected):",
    '  Agent(subagent_type="Explore", ...) — codebase research. Prefer this for most lookups. Fast and cheap.',
    '  Agent(subagent_type="Librarian", ...) — external docs, library APIs, web research.',
    '  Agent(subagent_type="Task", ...) — only when you need a subtask that writes files or runs complex multi-step commands.',
    "  Spawn multiple Explore agents in parallel for broad searches.",
      "- Use tools directly for quick lookups (cbm_search, lsp, ast_search, grep, etc.)",
      "- Present findings to the user and discuss them. Don't just dump raw results.",
      "- Do NOT modify project source code.",
      "",
      "# When to finish:",
      "Do NOT call pp_phase_complete on your own. The user will tell you when they're done,",
      "or use /pp to advance. Keep the conversation going until then.",
      "If the user asks you to implement, write code, or start building — tell them to use /pp which will offer \"Start implementation\" as an option. Do NOT implement directly in this session.",
      "",
      "# Optional artifacts (only when the conversation naturally produces them):",
      "If the discussion leads to a clear action plan or the user asks you to capture conclusions,",
      "write them to:",
      `- ${taskDir}/USER_REQUEST.md — MUST use structure: # User Request, ## Problem, ## Constraints`,
      `- ${taskDir}/RESEARCH.md — MUST use structure: ## Affected Code, ## Architecture Context, ## Constraints & Edge Cases, ## Open Questions (optional)`,
      "These files are validated. Missing or unexpected sections will be rejected.",
      "Do NOT create these files preemptively. Only write them when there's substance to capture.",
      "",
      "# Optional: focused analysis artifacts",
      `You may also write additional analysis files to ${taskDir}/artifacts/<name>.md`,
      "for deep dives on specific topics (e.g. architecture analysis, API comparison, risk assessment).",
      "Each artifact must start with # <Title>. Content is freeform. These are reviewed alongside USER_REQUEST.md and RESEARCH.md.",
      "Do NOT duplicate content already in RESEARCH.md — artifacts are for supplementary deep dives.",
      "",
      "Do NOT modify any files except .md files in the task directory.",
    ].join("\n");
  }

  return [
    "[PI-PI — BRAINSTORM PHASE]",
    `Task: ${taskDescription}`,
    "",
    "Your job is to produce USER_REQUEST.md and RESEARCH.md — complete enough that",
    "downstream agents can work without re-exploring the codebase or re-interviewing the user.",
    "",
    "# FORBIDDEN — do NOT do any of these:",
    "- Do NOT modify project source code (no write or edit tools on project files)",
    "- Do NOT create or modify any files outside the task directory",
    "- Do NOT start implementing — only research and document",
    "- If the user asks you to implement or start coding — tell them to use /pp which will offer phase advancement. Do NOT implement directly in this session.",
    "",
    "# Steps:",
    "1. Clarify requirements with the user if anything is ambiguous",
    "2. Spawn subagents for research (subagent_type is REQUIRED — calls without it are rejected):",
    '   - Agent(subagent_type="Explore", ...) — codebase research. Prefer this for most lookups. Fast and cheap.',
    '   - Agent(subagent_type="Librarian", ...) — external docs, library APIs, web research.',
    '   - Agent(subagent_type="Task", ...) — only when you need a subtask that writes files or runs complex multi-step commands.',
    "   Spawn multiple Explore agents in parallel for broad searches.",
    "3. Use tools to understand code structure:",
    "   - cbm_search: natural-language search across all symbols",
    "   - cbm_search_code: graph-augmented grep (deduplicates into functions)",
    "   - lsp documentSymbol, goToDefinition, findReferences, goToImplementation, hover",
    "   - cbm_trace: trace call chains for dependency understanding",
    "   - ast_search: find structural patterns across the codebase",
    "4. Ask the user follow-up questions as needed",
    "5. Write findings into RESEARCH.md as results come back — don't wait for all subagents",
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
    "  <Unresolved items needing user input. Omit section if none.>",
    "",
    "These files are validated programmatically. Missing sections or unexpected sections will be rejected.",
    "",
    "# Optional: focused analysis artifacts",
    `You may also write additional analysis files to ${taskDir}/artifacts/<name>.md`,
    "for deep dives on specific topics (e.g. architecture analysis, API comparison, risk assessment).",
    "Each artifact must start with # <Title>. Content is freeform. These are reviewed alongside USER_REQUEST.md and RESEARCH.md.",
    "Do NOT duplicate content already in RESEARCH.md — artifacts are for supplementary deep dives.",
    "",
    "Do NOT modify any files except .md files in the task directory.",
    "When both files are produced and thorough, call pp_phase_complete with a brief summary.",
  ].join("\n");
}

export async function spawnBrainstormReviewers(
  pi: ExtensionAPI,
  cwd: string,
  taskDir: string,
  taskId: string,
  config: PiPiConfig,
  round: number,
): Promise<{ spawned: number; files: string[]; agentIds: string[]; failedVariants: string[] }> {
  const urPath = join(taskDir, "USER_REQUEST.md");
  const resPath = join(taskDir, "RESEARCH.md");
  if (!existsSync(urPath) || !existsSync(resPath)) return { spawned: 0, files: [], agentIds: [], failedVariants: [] };

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
  const enabledVariants = Object.entries(config.brainstormReviewers).filter(([, v]) => v.enabled);
  const reviewFiles: string[] = [];
  const agentIds: string[] = [];
  const failedVariants: string[] = [];
  const results: Promise<void>[] = [];

  for (const [variant] of enabledVariants) {
    const outputPath = join(reviewsDir, `${timestamp}_${variant}_round-${round}.md`);
    reviewFiles.push(outputPath);
    const agent = createBrainstormReviewerAgent(variant, config, { userRequest, research, artifacts: artifacts.length > 0 ? artifacts : undefined }, outputPath);

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
          pi.sendMessage(
            {
              customType: "pp-brainstorm-reviewer-error",
              content: `Brainstorm reviewer variant "${variant}" failed: ${err.message}`,
              display: true,
            },
            { deliverAs: "steer" },
          );
        }
      })(),
    );
  }

  await Promise.allSettled(results);

  const reviewOutputFiles = existsSync(reviewsDir)
    ? readdirSync(reviewsDir).filter((f) => f.includes(`round-${round}`) && f.endsWith(".md"))
    : [];

  if (reviewOutputFiles.length > 0) {
    pi.sendMessage(
      {
        customType: "pp-brainstorm-reviews-done",
        content: [
          `${reviewOutputFiles.length} brainstorm reviewer(s) completed (round ${round}). Reviews in ${reviewsDir}:`,
          ...reviewOutputFiles.map((f) => `  - ${f}`),
          "",
          "Read all reviews and update USER_REQUEST.md and RESEARCH.md if needed.",
        ].join("\n"),
        display: true,
      },
      { deliverAs: "steer" },
    );
  } else if (enabledVariants.length > 0) {
    pi.sendMessage(
      {
        customType: "pp-brainstorm-reviews-error",
        content: [
          `All brainstorm reviewer variants failed (round ${round}) — no reviews were produced.`,
          "Proceeding without automatic brainstorm review.",
        ].join("\n"),
        display: true,
      },
      { deliverAs: "steer" },
    );
  }

  return { spawned: enabledVariants.length, files: reviewFiles, agentIds, failedVariants };
}
