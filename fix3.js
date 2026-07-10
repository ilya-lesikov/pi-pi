import fs from 'fs';

function updateFile(path, updater) {
  const content = fs.readFileSync(path, 'utf-8');
  const newContent = updater(content);
  if (content !== newContent) {
    fs.writeFileSync(path, newContent, 'utf-8');
    console.log(`Updated ${path}`);
  }
}

// Update constraintsBlock universal strings
updateFile('extensions/orchestrator/agents/constraints.ts', c => {
  let nc = c.replace(
    /        completionLine\(phase, mode\),/g,
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
  return nc;
});

// Hide state tools on success
updateFile('extensions/orchestrator/pp-state-tools.ts', c => {
  let nc = c;
  
  // Update pp_write_state_file
  nc = nc.replace(
    /    parameters: Type\.Object\(\{\n      path: Type\.String\(\{ description: "Path relative to the active task dir \(e\.g\. RESEARCH\.md, artifacts\/foo\.md\)" \}\),\n      content: Type\.String\(\{ description: "Full new file content" \}\),\n    \}\),\n    async execute\(_toolCallId, params: any\): Promise<ToolResult> \{/g,
    `    parameters: Type.Object({
      path: Type.String({ description: "Path relative to the active task dir (e.g. RESEARCH.md, artifacts/foo.md)" }),
      content: Type.String({ description: "Full new file content" }),
    }),
    renderShell: "self",
    renderCall: () => ({ render: () => [] }) as any,
    renderResult: (r: any, opts: any) => {
      if (!opts.isPartial && (!r.isError || !r.content?.[0]?.text?.startsWith("Failed to write"))) return { render: () => [] } as any;
      return { render: (w: number) => [(r.content?.[0]?.text || "Pending...").slice(0, w)] } as any;
    },
    async execute(_toolCallId, params: any): Promise<ToolResult> {`
  );
  
  // Update pp_edit_state_file
  nc = nc.replace(
    /    parameters: Type\.Object\(\{\n      path: Type\.String\(\{ description: "Path relative to the active task dir \(e\.g\. RESEARCH\.md\)" \}\),\n      oldText: Type\.String\(\{ description: "Exact text to replace" \}\),\n      newText: Type\.String\(\{ description: "Replacement text" \}\),\n      replaceAll: Type\.Optional\(Type\.Boolean\(\{ description: "Replace all occurrences \(default: false — oldText must be unique\)" \}\)\),\n    \}\),\n    async execute\(_toolCallId, params: any\): Promise<ToolResult> \{/g,
    `    parameters: Type.Object({
      path: Type.String({ description: "Path relative to the active task dir (e.g. RESEARCH.md)" }),
      oldText: Type.String({ description: "Exact text to replace" }),
      newText: Type.String({ description: "Replacement text" }),
      replaceAll: Type.Optional(Type.Boolean({ description: "Replace all occurrences (default: false — oldText must be unique)" })),
    }),
    renderShell: "self",
    renderCall: () => ({ render: () => [] }) as any,
    renderResult: (r: any, opts: any) => {
      if (!opts.isPartial && (!r.isError || !r.content?.[0]?.text?.startsWith("Failed to write"))) return { render: () => [] } as any;
      return { render: (w: number) => [(r.content?.[0]?.text || "Pending...").slice(0, w)] } as any;
    },
    async execute(_toolCallId, params: any): Promise<ToolResult> {`
  );
  
  return nc;
});

