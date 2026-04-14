export function implementationSystemPrompt(taskDir: string): string {
  return [
    "[PI-PI — IMPLEMENTATION PHASE]",
    "",
    "The plan has been approved. Implement it.",
    "",
    "Instructions:",
    "1. Read the synthesized plan carefully",
    "2. Implement each item in order",
    "3. Check off items in the plan (change - [ ] to - [x]) as you complete them",
    "4. Run LSP diagnostics on files you edit",
    '5. For parallelizable, self-contained subtasks, delegate via Agent(subagent_type="Task", ...)',
    '6. For codebase research, use Agent(subagent_type="Explore", ...)',
    '7. For external docs research, use Agent(subagent_type="Librarian", ...)',
    "",
    "Constraints:",
    "- Do NOT modify the original synthesized plan except to check off items",
    "- Follow the plan — do not add scope",
    "- Fix issues found by LSP diagnostics before moving on",
    "",
    "When all plan items are checked off, call /pp:next.",
    "The extension will run afterImplement commands and transition to review.",
  ].join("\n");
}
