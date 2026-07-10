import fs from 'fs';

function updateFile(path, updater) {
  const content = fs.readFileSync(path, 'utf-8');
  const newContent = updater(content);
  if (content !== newContent) {
    fs.writeFileSync(path, newContent, 'utf-8');
    console.log(`Updated ${path}`);
  }
}

// 1. pp-menu.ts: Swap meta and full in resumeOptionDescription
updateFile('extensions/orchestrator/pp-menu.ts', c => {
  return c.replace(
    'return full && full !== meta ? `${full}\\n${meta}` : meta;',
    'return full && full !== meta ? `${meta}\\n\\n${full}` : meta;'
  );
});

// 2. custom-footer.ts: Fold taskName into line 1
updateFile('extensions/orchestrator/custom-footer.ts', c => {
  let nc = c;
  
  // Update renderPathLine to include task name
  nc = nc.replace(
    /    line \+= ` • mode: \$\{mode\}`;([\s\S]*?)  \} else \{/m,
    /    line \+= ` • mode: \$\{mode\}`;$1    const name = taskNameFromState(task.dir, task.state);\n    if (name) line \+= ` • "${name}"`;\n  } else {/m
  );
  
  // Remove renderTaskNameLine function entirely
  nc = nc.replace(/function renderTaskNameLine.*?^}/ms, '');
  
  // Update createCustomFooter to exclude taskNameLine
  nc = nc.replace(
    /      const taskNameLine = renderTaskNameLine\(width, theme\);\n      const line2 = renderStatsLine\(width, theme\);\n      return taskNameLine === null \? \[line1, line2\] : \[line1, taskNameLine, line2\];/g,
    '      const line2 = renderStatsLine(width, theme);\n      return [line1, line2];'
  );

  return nc;
});

// 3. Update orchestrator/agents/advisor.ts to split into parameterized createAdvisorAgent
updateFile('extensions/orchestrator/agents/advisor.ts', c => {
  return `import type { PiPiConfig, SimpleSubagentRole } from "../config.js";
import { resolveModel } from "../model-registry.js";
import { TOOLS_BLOCK, ALL_CBM_TOOLS, EXA_TOOLS, PRINCIPLES_BLOCK } from "./tool-routing.js";

export function createAdvisorAgent(config: PiPiConfig, role: SimpleSubagentRole) {
  const agentConfig = config.agents.subagents.simple[role];
  return {
    frontmatter: {
      description: \`Deep-reasoning advisor for design decisions and 'why is this broken' analysis (\${role}, pi-pi)\`,
      tools: \`read, bash, grep, find, ls, lsp, ast_search, \${ALL_CBM_TOOLS}, \${EXA_TOOLS}\`,
      model: resolveModel(agentConfig.model),
      thinking: agentConfig.thinking,
      max_turns: 120,
      prompt_mode: "replace",
    },
    prompt: [
      "<constraints>",
      "You are a deep-reasoning ADVISOR. You investigate one hard question — a design decision, an architecture tradeoff, a \\"why is this broken\\", or a correctness/soundness judgment — and return a reasoned recommendation backed by evidence.",
      "These rules override your default helpfulness. Strict compliance is required.",
      "You are READ-ONLY: you MUST NOT modify any file. Diagnose and advise; do NOT change code.",
      "</constraints>",
      "",
      PRINCIPLES_BLOCK,
      "",
      TOOLS_BLOCK,
      "",
      "<task>",
      "- Verify every claim with tool calls — read the actual code. Never reason from memory about this codebase.",
      "- Generate multiple competing hypotheses or approaches before converging. Surface and question hidden assumptions.",
      "- Scope recommendations by effort: name the quick fix vs the thorough one.",
      "- Structure your answer: Diagnosis (what is actually true, with file:line evidence) → Options & tradeoffs → Recommendation.",
      "- Be honest about uncertainty. If evidence is thin, say so and state what would resolve it.",
      "</task>",
    ].join("\\n"),
  };
}
`;
});

// 4. Update config.ts with new advisors
updateFile('extensions/orchestrator/config.ts', c => {
  let nc = c;
  
  // Update SimpleSubagentRole
  nc = nc.replace(
    /export type SimpleSubagentRole = .*?;/g,
    'export type SimpleSubagentRole = "explore" | "librarian" | "task" | "advisor" | "advisor2" | "advisor3" | "deep-debugger" | "reviewer";'
  );
  
  // Update SIMPLE_SUBAGENT_ROLES
  nc = nc.replace(
    /const SIMPLE_SUBAGENT_ROLES: SimpleSubagentRole\[\] = \[.*?\];/g,
    'const SIMPLE_SUBAGENT_ROLES: SimpleSubagentRole[] = ["explore", "librarian", "task", "advisor", "advisor2", "advisor3", "deep-debugger", "reviewer"];'
  );
  
  // Update DEFAULT_CONFIG
  nc = nc.replace(
    /advisor: \{ model: "anthropic\/claude-3-5-sonnet-latest", thinking: "off" \},/g,
    `advisor: { model: "anthropic/claude-3-5-sonnet-latest", thinking: "off" },
        advisor2: { model: "openai/gpt-latest", thinking: "high" },
        advisor3: { model: "google/gemini-pro-latest", thinking: "high" },`
  );
  
  return nc;
});
