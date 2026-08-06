import type { VariantConfig } from "../config.js";
import { loadAllContextFiles, formatManifestBlock } from "../context.js";
import { resolveModel, getModelInfo } from "../model-registry.js";
import type { RepoInfo } from "../repo-utils.js";
import { buildRepoContext } from "./repo-context.js";
import { toolsBlock, parseToolNames, identityBlock, ALL_CBM_TOOLS, EXA_TOOLS, PRINCIPLES_BLOCK } from "./tool-routing.js";

export function createPlannerAgent(
  variant: string,
  variants: Record<string, VariantConfig>,
  taskArtifacts: { userRequest: string; research: string; manifest?: { title: string; path: string }[] },
  outputPath: string,
  contextDirs: string[],
  phase?: string,
  repos: RepoInfo[] = [],
) {
  const variantConfig = variants[variant];
  if (!variantConfig) {
    throw new Error(`Unknown planner variant: ${variant}`);
  }
  const info = getModelInfo(resolveModel(variantConfig.model));
  const contextFiles = loadAllContextFiles(contextDirs, "planner", "system", phase, getModelInfo(variantConfig.model));
  const contextBlock = contextFiles.map((f) => f.content).join("\n\n");
  const repoContext = buildRepoContext(repos);
  const tools = `read, grep, find, bash, write, lsp, ast_search, ${ALL_CBM_TOOLS}, ${EXA_TOOLS}`;

  return {
    frontmatter: {
      description: `Planner (${variant} variant, pi-pi)`,
      tools,
      model: resolveModel(variantConfig.model),
      thinking: variantConfig.thinking,
      max_turns: 240,
      prompt_mode: "replace",
    },
    prompt: [
      identityBlock({ displayName: info.displayName, family: info.family, tier: info.tier, thinking: variantConfig.thinking }),
      "",
      // --- static prefix (cacheable) ---
      "<constraints>",
      "You are a planning agent. You produce a detailed implementation PLAN — you do NOT implement it.",
      "These rules override your default helpfulness. Strict compliance is required.",
      "You are READ-ONLY: you MUST NOT write, edit, or create any file except the single plan .md file named below. You MUST NOT modify source, tests, configs, or run state-changing bash. If you catch yourself implementing, STOP and return to planning.",
      "Your task is NOT complete until the plan file exists — you MUST write it before finishing.",
      "WRITE-FIRST (MANDATORY, do this as your VERY FIRST action before any reading/thinking): immediately `write` the plan file (path below) with a one-line stub — `PLAN_STATUS: INCOMPLETE`. Only AFTER your planning is done, OVERWRITE the same file with your real plan whose LAST line is `PLAN_STATUS: COMPLETE`. This guarantees the file exists even if you run out of budget mid-plan; a stub-only file is treated as 'planner produced no plan' and the variant is respawned.",
      "</constraints>",
      "",
      PRINCIPLES_BLOCK,
      "",
      toolsBlock(parseToolNames(tools)),
      "",
      ...(contextBlock ? ["<project_context>", contextBlock, "</project_context>", ""] : []),
      "<task>",
      "Plan format rules:",
      "- Start with # Plan",
      "- ## Scope: 2-4 lines — what changes, what doesn't, critical constraints",
      "- ## Checklist: each item is - [ ] <outcome> — Done when: <observable condition>",
      "  Each item = one independently verifiable outcome, right-sized to the smallest chunk worth verifying on its own. No code snippets or file-by-file instructions. Nest these INSIDE the Done-when condition (do not add sections or code): (a) a verification method — how the outcome is proven (test passes, diagnostics clean, command output); (b) for items meant for parallel delegation, the interface it consumes/produces (what earlier outcomes it depends on, what later ones depend on it); (c) NO unresolved items — an item that defers a decision instead of stating a concrete outcome is a plan failure; resolve it now (in any language: a placeholder such as 'TBD'/'TODO'/'decide later' is only an illustrative example of the deferral to avoid, not the literal thing being matched).",
      "- ## Pattern constraints: include whenever the task adds a type, function, parser, annotation, config key, enum, or user-facing value. For each, name the CLOSEST EXISTING analog (found by behavior, not filename) and the conventions the implementer MUST mirror: data shape (prefer one existing shape over parallel/duplicated state), spelling/casing of user-facing values (match existing — never invent a new casing), and parser/validation/error-handling shape. Acceptance criteria, not suggestions. Omit only if the task adds none of the above.",
      "- ## Blockers: unresolved issues blocking implementation (omit if none)",
      "- No other top-level sections allowed — the single trailing `PLAN_STATUS: COMPLETE` line is the one permitted exception",
      "- Describe outcomes, not code-level mechanics, EXCEPT in ## Pattern constraints where the concrete analog and conventions are required",
      "",
      "You may spawn ONLY explore/librarian subagents (subagent_type is REQUIRED — calls without it are rejected):",
    '- Agent(subagent_type="explore", ...) — codebase research. Prefer this for most lookups. Fast and cheap.',
    '- Agent(subagent_type="librarian", ...) — external docs, library APIs, web research.',
    "Spawn multiple explore agents in parallel for broad searches. Do NOT spawn task, advisor, deep-debugger, or reviewer.",
      "(You are a phased planner; the on-demand advisor/reviewer/deep-debugger pools are for the main agent, not for you.)",
      "</task>",
      "",
      // --- dynamic suffix ---
      "# MANDATORY OUTPUT FILE (write a stub here FIRST, overwrite with the final plan LAST):",
      `  ${outputPath}`,
      "Step 0 (before anything else): write this file with exactly:",
      "  PLAN_STATUS: INCOMPLETE",
      "Final step: overwrite it with your full plan ending in `PLAN_STATUS: COMPLETE`.",
      "",
      "=== USER REQUEST ===",
      taskArtifacts.userRequest,
      "",
      "=== RESEARCH ===",
      taskArtifacts.research,
      ...(repoContext ? [repoContext] : []),
      "",
      formatManifestBlock(taskArtifacts.manifest ?? []),
    ].join("\n"),
  };
}
