import fs from 'fs';

function updateFile(path, updater) {
  const content = fs.readFileSync(path, 'utf-8');
  const newContent = updater(content);
  if (content !== newContent) {
    fs.writeFileSync(path, newContent, 'utf-8');
    console.log(`Updated ${path}`);
  }
}

// Ensure universal rules land
updateFile('extensions/orchestrator/agents/constraints.ts', c => {
  let nc = c;
  if (!nc.includes("State-file bookkeeping is silent")) {
    nc = nc.replace(
      /    completionLine\(phase, mode\),/g,
      `    "State-file bookkeeping is silent: writing/updating .pp state files (USER_REQUEST.md,",
      "RESEARCH.md, artifacts/*.md, plans) is routine — do it without asking permission and",
      "without narrating each write. Batch edits; don't re-announce them.",
      "",
      "Asks are focused: one question per ask_user call — never bundle multiple decisions.",
      "Put the substantive context in your message (or the context field) BEFORE the call, so",
      "the terse question/options are interpretable. Never add an \\"I'll answer in a comment\\"",
      "option; the built-in freeform answer already covers that. Spawn multiple focused asks in",
      "sequence rather than one combined prompt.",
      completionLine(phase, mode),`
    );
  }
  return nc;
});

// Streamlining flow - planning
updateFile('extensions/orchestrator/phases/planning.ts', c => {
  return c.replace(
    /"- Start with # Plan",/g,
    `"If you need clarification, batch it early rather than interrupting mid-work. Avoid",
    "mid-flight questions; you run off the approved USER_REQUEST/RESEARCH/plan. A genuine",
    "blocker is the only reason to stop and ask.",
    "",
    "- Start with # Plan",`
  );
});

// Streamlining flow - implementation
updateFile('extensions/orchestrator/phases/implementation.ts', c => {
  return c.replace(
    /"1\. Review the synthesized plan in your context",/g,
    `"If you need clarification, batch it early rather than interrupting mid-work. Avoid",
    "mid-flight questions; you run off the approved USER_REQUEST/RESEARCH/plan. A genuine",
    "blocker is the only reason to stop and ask.",
    "",
    "1. Review the synthesized plan in your context",`
  );
});

// ask_user single hotkey -> ctrl+e
updateFile('3p/pi-ask-user/index.ts', c => {
  let nc = c;
  nc = nc.replace(
    /private commentToggle: ResolvedShortcut;/g,
    ''
  ).replace(
    /commentToggle: ResolvedShortcut,/g,
    ''
  ).replace(
    /this\.commentToggle = commentToggle;/g,
    ''
  ).replace(
    /commentToggleKey\?: string \| null;/g,
    ''
  ).replace(
    /public isCommentEnabled\(\): boolean \{\n      return this\.commentEnabled;\n   \}/g,
    ''
  ).replace(
    /private commentEnabled = false;/g,
    ''
  ).replace(
    /private toggleComment\(\): void \{\n      if \(!this\.allowComment\) return;\n      this\.commentEnabled = !this\.commentEnabled;\n      this\.invalidate\(\);\n   \}/g,
    ''
  ).replace(
    /if \(this\.allowComment && !this\.commentToggle\.disabled && this\.commentToggle\.matches\(data\)\) \{\n         this\.toggleComment\(\);\n         return;\n      \}/g,
    ''
  ).replace(
    /const commentHint = this\.allowComment && !this\.shortcuts\.commentToggle\.disabled\n         \? literalHint\(theme, this\.shortcuts\.commentToggle\.spec, "add text"\)\n         : null;/g,
    `const commentHint = this.allowComment ? literalHint(theme, "ctrl+e", "add context") : null;`
  ).replace(
    /if \(this\.isCommentToggleRow\(i\)\) \{\n            const checkbox = this\.commentEnabled \? theme\.fg\("success", "\[✓\]"\) : theme\.fg\("dim", "\[ \]"*\);\n            const label = isSelected\n               \? theme\.fg\("accent", theme\.bold\(COMMENT_TOGGLE_LABEL\)\)\n               : theme\.fg\("text", theme\.bold\(COMMENT_TOGGLE_LABEL\)\);\n            lines\.push\(truncateToWidth\(\`\$\{prefix\}   \$\{checkbox\} \$\{label\}\`, width, ""\)\);\n            continue;\n         \}/g,
    ''
  ).replace(
    /private getCommentToggleIndex\(\): number \| null \{\n      return this\.allowComment \? this\.options\.length : null;\n   \}/g,
    ''
  ).replace(
    /private isCommentToggleRow\(index: number\): boolean \{\n      const toggleIndex = this\.getCommentToggleIndex\(\);\n      return toggleIndex !== null && index === toggleIndex;\n   \}/g,
    ''
  ).replace(
    /private isCommentToggleRow.*?\{([\s\S]*?)\}/g,
    ''
  ).replace(
    /if \(this\.isCommentToggleRow.*?\{([\s\S]*?)\}/g,
    ''
  ).replace(
    /const commentHint = this\.allowComment \? "\\n\\nAfter choosing an option, you may add an optional comment\." : "";/g,
    'const commentHint = this.allowComment ? "\\n\\nAfter choosing an option, you may add an optional comment or use ctrl+e." : "";'
  ).replace(
    /if \(matchesKey\(data, Key\.space\) && count > 0 && this\.isCommentToggleRow\(this\.selectedIndex, filteredOptions\)\) \{\n         this\.toggleComment\(\);\n         return;\n      \}/g,
    ''
  );
  
  // Single-select handleInput hotkeys
  nc = nc.replace(
    /      if \(this\.keybindings\.matches\(data, "tui\.select\.confirm"\) && count > 0\) \{\n         if \(this\.isCommentToggleRow\(this\.selectedIndex, filteredOptions\)\) \{\n            this\.toggleComment\(\);\n            return;\n         \}/g,
    `      if (data === "\\x05" /* ctrl+e */ && this.allowComment && count > 0) {
         if (this.isFreeformRow(this.selectedIndex, filteredOptions)) {
            this.onEnterFreeform?.();
            return;
         }
         const result = filteredOptions[this.selectedIndex]?.title;
         if (result) this.handleSelectionSubmit([result], true);
         return;
      }

      if (this.keybindings.matches(data, "tui.select.confirm") && count > 0) {`
  );
  
  // WrapSingleSelect list lines - handle handleselectionsubmit override
  nc = nc.replace(
    /public onSubmit\?: \(result: string\) => void;/g,
    `public onSubmit?: (result: string) => void;
   public handleSelectionSubmit: (selections: string[], wantsComment: boolean) => void = () => {};`
  );
  
  return nc;
});
