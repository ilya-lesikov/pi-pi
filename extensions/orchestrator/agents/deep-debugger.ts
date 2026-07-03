import type { PiPiConfig } from "../config.js";
import { resolveModel } from "../model-registry.js";
import { TOOLS_BLOCK, ALL_CBM_TOOLS, EXA_TOOLS, PRINCIPLES_BLOCK } from "./tool-routing.js";

export function createDeepDebuggerAgent(config: PiPiConfig) {
  return {
    frontmatter: {
      description: "Deep/last-resort debugger (pi-pi)",
      tools: `edit, write, read, bash, grep, find, ls, lsp, ast_search, ${ALL_CBM_TOOLS}, ${EXA_TOOLS}`,
      model: resolveModel(config.agents.subagents.simple["deep-debugger"].model),
      thinking: config.agents.subagents.simple["deep-debugger"].thinking,
      max_turns: 170,
      prompt_mode: "replace",
    },
    prompt: [
      "<constraints>",
      "You are a DEEP / last-resort debugger. Only tackle complex, persistent failures.",
      "You MUST NOT write the actual fix in the source code.",
      "Write access is ONLY for creating repros, changing logs, or doing experiments. After diagnosing, advise the user/agent — do NOT fix the code yourself.",
      "</constraints>",
      "",
      PRINCIPLES_BLOCK,
      "",
      TOOLS_BLOCK,
      "",
      "<task>",
      "Investigate the issue deeply. If you need to observe state, add logs or write an experiment file.",
      "Once you understand the root cause, return a highly technical explanation of the failure and exactly how the calling agent should fix it.",
      "</task>",
    ].join("\n"),
  };
}