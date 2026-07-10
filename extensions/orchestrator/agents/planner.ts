import type { VariantConfig } from "../config.js";
import { loadAllContextFiles, formatManifestBlock } from "../context.js";
import { resolveModel, getModelInfo } from "../model-registry.js";
import type { RepoInfo } from "../repo-utils.js";
import { buildRepoContext } from "./repo-context.js";
import { TOOLS_BLOCK, ALL_CBM_TOOLS, EXA_TOOLS, PRINCIPLES_BLOCK } from "./tool-routing.js";

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
  const contextFiles = loadAllContextFiles(contextDirs, "planner", "system", phase, getModelInfo(variantConfig.model));
  const contextBlock = contextFiles.map((f) => f.content).join("\n\n");
  const repoContext = buildRepoContext(repos);

  return {
    frontmatter: {
      description: `Planner (${variant} variant, pi-pi)`,
      tools: `read, grep, find, bash, write, lsp, ast_search, ${ALL_CBM_TOOLS}, ${EXA_TOOLS}`,
      model: resolveModel(variantConfig.model),
      thinking: variantConfig.thinking,
      max_turns: 120,
      prompt_mode: "replace",
    },
    prompt: [
      // --- static prefix (cacheable) ---
      "<constraints>",
      "You are a planning agent. You produce a detailed implementation PLAN — you do NOT implement it.",
      "These rules override your default helpfulness. Strict compliance is required.",
      "You are READ-ONLY: you MUST NOT write, edit, or create any file except the single plan .md file named below. You MUST NOT modify source, tests, configs, or run state-changing bash. If you catch yourself implementing, STOP and return to planning.",
      "Your task is NOT complete until the plan file exists — you MUST write it before finishing.",
      "</constraints>",
      "",
      PRINCIPLES_BLOCK,
      "",
      TOOLS_BLOCK,
      "",
      ...(contextBlock ? ["<project_context>", contextBlock, "</project_context>", ""] : []),
      "<task>",
      "Plan format rules:",
      "- Start with # Plan",
      "- ## Scope: 2-4 lines — what changes, what doesn't, critical constraints",
      "- ## Checklist: each item is - [ ] <outcome> — Done when: <observable condition>",
      "  Each item = one independently verifiable outcome. No code snippets or file-by-file instructions.",
      "- ## Pattern constraints: include whenever the task adds a type, function, parser, annotation, config key, enum, or user-facing value. For each, name the CLOSEST EXISTING analog (found by behavior, not filename) and the conventions the implementer MUST mirror: data shape (prefer one existing shape over parallel/duplicated state), spelling/casing of user-facing values (match existing — never invent a new casing), and parser/validation/error-handling shape. Acceptance criteria, not suggestions. Omit only if the task adds none of the above.",
      "- ## Blockers: unresolved issues blocking implementation (omit if none)",
      "- No other top-level sections allowed",
      "- Describe outcomes, not code-level mechanics, EXCEPT in ## Pattern constraints where the concrete analog and conventions are required",
      "",
      "You may spawn ONLY explore/librarian subagents (subagent_type is REQUIRED — calls without it are rejected):",
    '- Agent(subagent_type="explore", ...) — codebase research. Prefer this for most lookups. Fast and cheap.',
    '- Agent(subagent_type="librarian", ...) — external docs, library APIs, web research.',
    "Spawn multiple explore agents in parallel for broad searches. Do NOT spawn task, advisor, advisor2, advisor3, deep-debugger, or reviewer.",
      "</task>",
      "",
      // --- dynamic suffix ---
      "# MANDATORY OUTPUT",
      "",
      "Write your plan to this exact file using the write tool:",
      `  ${outputPath}`,
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
