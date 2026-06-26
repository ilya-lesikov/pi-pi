import type { VariantConfig } from "../config.js";
import { loadAllContextFiles } from "../context.js";
import { resolveModel, getModelInfo } from "../model-registry.js";
import type { RepoInfo } from "../repo-utils.js";
import { buildRepoContext } from "./repo-context.js";
import { TOOL_ROUTING, ALL_CBM_TOOLS, EXA_TOOLS, WORKING_PRINCIPLES_READONLY, COMMUNICATION } from "./tool-routing.js";

export function createPlannerAgent(
  variant: string,
  variants: Record<string, VariantConfig>,
  taskArtifacts: { userRequest: string; research: string },
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
      ...(contextBlock ? ["# Project Context", "", contextBlock, ""] : []),
      // --- static prefix (cacheable) ---
      "You are a planning agent. Your job is to create a detailed implementation plan.",
      "",
      WORKING_PRINCIPLES_READONLY,
      "",
      COMMUNICATION,
      "",
      TOOL_ROUTING,
      "",
      "Plan format rules:",
      "- Start with # Plan",
      "- ## Scope: 2-4 lines — what changes, what doesn't, critical constraints",
      "- ## Checklist: each item is - [ ] <outcome> — Done when: <observable condition>",
      "  Each item = one independently verifiable outcome. No code snippets or file-by-file instructions.",
      "- ## Blockers: unresolved issues blocking implementation (omit if none)",
      "- No other top-level sections allowed",
      "- Describe outcomes, not code-level mechanics",
      "",
      "subagent_type is REQUIRED when spawning subagents — calls without it are rejected:",
    '- Agent(subagent_type="Explore", ...) — codebase research. Prefer this for most lookups. Fast and cheap.',
    '- Agent(subagent_type="Librarian", ...) — external docs, library APIs, web research.',
    "Spawn multiple Explore agents in parallel for broad searches.",
      "",
      // --- dynamic suffix ---
      "# MANDATORY OUTPUT",
      "",
      "Write your plan to this exact file using the write tool:",
      `  ${outputPath}`,
      "",
      "Your task is NOT complete until this file exists. Do NOT finish without writing it.",
      "",
      "# CRITICAL: DO NOT IMPLEMENT ANYTHING",
      "",
      "You are a PLANNER, not an implementer. Your ONLY output is the plan file above.",
      "- Do NOT write, edit, or create any file outside .pp/state/",
      "- Do NOT create fix scripts, patches, or code files",
      "- Do NOT modify source code, tests, configs, or any project file",
      "- Do NOT use bash to write files (no echo >, sed -i, tee, scripts, etc.)",
      "- If you catch yourself starting to implement — STOP IMMEDIATELY and go back to planning",
      "- Violating this will cause your output to be DISCARDED",
      "",
      "=== USER REQUEST ===",
      taskArtifacts.userRequest,
      "",
      "=== RESEARCH ===",
      taskArtifacts.research,
      ...(repoContext ? [repoContext] : []),
      "",
      "The artifacts above are already in your context. Do NOT re-read them from disk.",
    ].join("\n"),
  };
}
