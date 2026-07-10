import fs from 'fs';

function updateFile(path, updater) {
  const content = fs.readFileSync(path, 'utf-8');
  const newContent = updater(content);
  if (content !== newContent) {
    fs.writeFileSync(path, newContent, 'utf-8');
    console.log(`Updated ${path}`);
  }
}

updateFile('extensions/orchestrator/phases/brainstorm.ts', c => {
  let nc = c.replace(
    /"2\. Delegate research to subagents where useful \(\w.*?\), and use bash to run commands, check logs, reproduce issues",/g,
    `"2. Delegate research to subagents where useful (see the delegation guidance in your system prompt), and use bash to run commands, check logs, reproduce issues",
    "",
    "# Flow (minimize interruptions):",
    "1. CLARIFY UP-FRONT: if the request is ambiguous, ask your clarifying question(s) now,",
    "   at the very start — batch them. If it's clear, skip straight to step 2.",
    "2. WORK AUTONOMOUSLY: research, explore, and design without stopping to ask. Delegate to",
    "   subagents (parallel explores for broad searches). Do NOT interrupt mid-flow with",
    "   questions — collect uncertainties for step 4 instead. Only a genuine blocker (you",
    "   cannot proceed at all) justifies an ask here.",
    "3. CONSULT AN ADVISOR: before presenting, get an independent second opinion from an",
    "   advisor whose model family differs from yours. You run on GPT, so default",
    "   to advisor (opus). Escalate to a second/third advisor for hard or high-stakes calls.",
    "4. CLARIFY AT THE END: surface any remaining decisions as focused asks — one at a time.",
    "5. APPROVE COMMITTED SPECIFICS: before finalizing, when your output commits to concrete,",
    "   costly-to-reverse or opinion-heavy choices — exact wording, structure, naming, default",
    "   values, or interface signatures — show the ACTUAL proposed text/values inline in your",
    "   message, then ask for explicit approval. Don't silently invent and bury them.",
    "6. PRESENT RESULTS: end with a structured summary (what you found, the decisions, the",
    "   recommended direction) and hand back with the standard closing block.",`
  ).replace(
    /"2\. Delegate research to subagents where useful \(see the delegation guidance in your system prompt\) — spawn multiple explores in parallel for broad searches",/g,
    `"2. Delegate research to subagents where useful (see the delegation guidance in your system prompt) — spawn multiple explores in parallel for broad searches",
    "",
    "# Flow (minimize interruptions):",
    "1. CLARIFY UP-FRONT: if the request is ambiguous, ask your clarifying question(s) now,",
    "   at the very start — batch them. If it's clear, skip straight to step 2.",
    "2. WORK AUTONOMOUSLY: research, explore, and design without stopping to ask. Delegate to",
    "   subagents (parallel explores for broad searches). Do NOT interrupt mid-flow with",
    "   questions — collect uncertainties for step 4 instead. Only a genuine blocker (you",
    "   cannot proceed at all) justifies an ask here.",
    "3. CONSULT AN ADVISOR: before presenting, get an independent second opinion from an",
    "   advisor whose model family differs from yours. You run on Claude, so default",
    "   to advisor2 (gpt). Escalate to a second/third advisor for hard or high-stakes calls.",
    "4. CLARIFY AT THE END: surface any remaining decisions as focused asks — one at a time.",
    "5. APPROVE COMMITTED SPECIFICS: before finalizing, when your output commits to concrete,",
    "   costly-to-reverse or opinion-heavy choices — exact wording, structure, naming, default",
    "   values, or interface signatures — show the ACTUAL proposed text/values inline in your",
    "   message, then ask for explicit approval. Don't silently invent and bury them.",
    "6. PRESENT RESULTS: end with a structured summary (what you found, the decisions, the",
    "   recommended direction) and hand back with the standard closing block.",`
  );
  return nc;
});

updateFile('extensions/orchestrator/phases/review.ts', c => {
  let nc = c.replace(
    /"2\. Synthesize into \$\{reviewsDir\}\/<unix-epoch-seconds>_final_pass-\$\{pass\}\.md \(prefix with the current Unix epoch seconds, e\.g\. \\\`date \+%s\\\`, so the file orders chronologically\)",/g,
    `"2. Synthesize into \$\{reviewsDir\}/<unix-epoch-seconds>_final_pass-\$\{pass\}.md (prefix with the current Unix epoch seconds, e.g. \\\`date +%s\\\`, so the file orders chronologically)",
    "",
    "# Flow (minimize interruptions):",
    "1. CLARIFY UP-FRONT: if the request is ambiguous, ask your clarifying question(s) now,",
    "   at the very start — batch them. If it's clear, skip straight to step 2.",
    "2. WORK AUTONOMOUSLY: research, explore, and design without stopping to ask. Delegate to",
    "   subagents (parallel explores for broad searches). Do NOT interrupt mid-flow with",
    "   questions — collect uncertainties for step 4 instead. Only a genuine blocker (you",
    "   cannot proceed at all) justifies an ask here.",
    "3. CONSULT AN ADVISOR: before presenting, get an independent second opinion from an",
    "   advisor whose model family differs from yours. You run on Claude, so default",
    "   to advisor2 (gpt). Escalate to a second/third advisor for hard or high-stakes calls.",
    "4. CLARIFY AT THE END: surface any remaining decisions as focused asks — one at a time.",
    "5. APPROVE COMMITTED SPECIFICS: before finalizing, when your output commits to concrete,",
    "   costly-to-reverse or opinion-heavy choices — exact wording, structure, naming, default",
    "   values, or interface signatures — show the ACTUAL proposed text/values inline in your",
    "   message, then ask for explicit approval. Don't silently invent and bury them.",
    "6. PRESENT RESULTS: end with a structured summary (what you found, the decisions, the",
    "   recommended direction) and hand back with the standard closing block.",`
  );
  return nc;
});
