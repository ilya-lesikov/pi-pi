import fs from 'fs';

function updateFile(path, updater) {
  const content = fs.readFileSync(path, 'utf-8');
  const newContent = updater(content);
  if (content !== newContent) {
    fs.writeFileSync(path, newContent, 'utf-8');
    console.log(`Updated ${path}`);
  }
}

// 5. Update orchestrator.ts to register all 3 advisors
updateFile('extensions/orchestrator/orchestrator.ts', c => {
  let nc = c;
  nc = nc.replace(
    /const advisor = createAdvisorAgent\(this\.config\);/g,
    `const advisor = createAdvisorAgent(this.config, "advisor");
    const advisor2 = createAdvisorAgent(this.config, "advisor2");
    const advisor3 = createAdvisorAgent(this.config, "advisor3");`
  );
  
  nc = nc.replace(
    /      \{\n        type: "advisor",\n        variant: null,\n        \.\.\.advisor,\n        prompt: appendContext\("advisor", advisor\.prompt, getModelInfo\(resolveModel\(this\.config\.agents\.subagents\.simple\.advisor\.model\)\)\),\n      \},/,
    `      {
        type: "advisor",
        variant: null,
        ...advisor,
        prompt: appendContext("advisor", advisor.prompt, getModelInfo(resolveModel(this.config.agents.subagents.simple.advisor.model))),
      },
      {
        type: "advisor2",
        variant: null,
        ...advisor2,
        prompt: appendContext("advisor2", advisor2.prompt, getModelInfo(resolveModel(this.config.agents.subagents.simple.advisor2.model))),
      },
      {
        type: "advisor3",
        variant: null,
        ...advisor3,
        prompt: appendContext("advisor3", advisor3.prompt, getModelInfo(resolveModel(this.config.agents.subagents.simple.advisor3.model))),
      },`
  );
  return nc;
});

// 6. Update tool-routing.ts to include advisor2/advisor3
updateFile('extensions/orchestrator/agents/tool-routing.ts', c => {
  return c.replace(
    /"  Do NOT spawn task, advisor, deep-debugger, or reviewer subagents\.",/g,
    `"  Do NOT spawn task, advisor, advisor2, advisor3, deep-debugger, or reviewer subagents.",`
  ).replace(
    /'- A judgment call \\(design tradeoff, "is this correct", "why is this broken"\\)  → advisor',/g,
    `'- A judgment call (design tradeoff, "is this correct", "why is this broken")  → advisor/advisor2/advisor3',`
  );
});

// Update specific agents
const agents = ['brainstorm-reviewer', 'code-reviewer', 'plan-reviewer', 'task'];
for (const agent of agents) {
  updateFile(`extensions/orchestrator/agents/${agent}.ts`, c => {
    return c.replace(
      /Do NOT spawn task, advisor, deep-debugger, or reviewer\./g,
      `Do NOT spawn task, advisor, advisor2, advisor3, deep-debugger, or reviewer subagents.`
    ).replace(
      /"  Do NOT spawn task, advisor, deep-debugger, or reviewer subagents\.",/g,
      `"  Do NOT spawn task, advisor, advisor2, advisor3, deep-debugger, or reviewer subagents.",`
    );
  });
}

