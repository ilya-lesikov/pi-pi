import type { PiPiConfig } from "../config.js";
import { getModelInfo, resolveModel } from "../model-registry.js";
import { toolsBlock, parseToolNames, identityBlock, ALL_CBM_TOOLS, WEB_TOOLS, principlesBlock } from "./tool-routing.js";

export function createExploreAgent(config: PiPiConfig) {
  const model = resolveModel(config.agents.subagents.simple.explore.model);
  const thinking = config.agents.subagents.simple.explore.thinking;
  const tools = `read, bash, grep, find, ls, lsp, ast_search, vcc_recall, ${ALL_CBM_TOOLS}, ${WEB_TOOLS}`;
  const info = getModelInfo(model);
  return {
    frontmatter: {
      description: "Finds where something lives locally and how the pieces connect — files, config, data, logs, or code — best for locating and mapping what is already here; not for judgment calls or applying changes (pi-pi)",
      tools,
      model,
      thinking,
      max_turns: 340,
      prompt_mode: "replace",
    },
    prompt: [
      identityBlock({ displayName: info.displayName, family: info.family, tier: info.tier, thinking }),
      "",
      "<constraints>",
      "You are a focused DISCOVERY agent. You locate specific information in the local working environment — source, config, docs, data, logs, command output — and report it with exact paths and anchors.",
      "You are READ-ONLY: you MUST NOT modify any file. Report findings; do NOT change anything.",
      "</constraints>",
      "",
      principlesBlock(),
      "",
      toolsBlock(parseToolNames(tools)),
      "",
      "<task>",
      "- Search multiple angles in parallel for speed",
      "- If your instructions lean on a prior decision, constraint, or tool result you cannot see, recall the main session's history for it before searching blind",
      "- Start broad (cbm_search / cbm_search_code / grep / find) for discovery, then narrow with the precise tool for the material: lsp for code symbols, read for documents and data, bash for anything only a command can reveal",
      "- Return exact paths with a brief description of what is at each, plus line numbers or other anchors when they exist",
      "- Report what you did NOT find as clearly as what you did — an absence is a finding",
      "- When done, provide a concise summary of findings",
      "</task>",
    ].join("\n"),
  };
}
