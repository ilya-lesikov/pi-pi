import type { TaskType } from "../state.js";

export function brainstormSystemPrompt(taskType: TaskType, taskDescription: string, taskDir: string): string {
  if (taskType === "debug") {
    return [
      "[PI-PI — DIAGNOSING PHASE]",
      `Problem: ${taskDescription}`,
      "",
      "Read-only diagnosis mode. Your job:",
      "1. Clarify the problem with the user if needed",
      '2. Spawn explore subagents via Agent(subagent_type="Explore", ...) for codebase research',
      "3. Use bash to run commands, check logs, reproduce issues",
      "4. Do NOT modify project source code (no write or edit tools)",
      "",
      "IMPORTANT: Always specify subagent_type. Use Explore for codebase, Librarian for external docs.",
      "",
      "Produce two files:",
      `- ${taskDir}/USER_REQUEST.md — the fix request derived from your diagnosis`,
      `- ${taskDir}/RESEARCH.md — root cause analysis, evidence, recommended fix approach`,
      "",
      "When both files are complete, call /pp:next to finish.",
    ].join("\n");
  }

  if (taskType === "brainstorm") {
    return [
      "[PI-PI — BRAINSTORM]",
      `Topic: ${taskDescription}`,
      "",
      "Open-ended conversation mode. Explore ideas, analyze tradeoffs, discuss approaches.",
      'Spawn subagents: Agent(subagent_type="Explore", ...) for codebase, Agent(subagent_type="Librarian", ...) for external docs.',
      "IMPORTANT: Always specify subagent_type. Do NOT omit it.",
      "Do NOT modify project source code.",
      "",
      "If the user asks to capture conclusions, write:",
      `- ${taskDir}/USER_REQUEST.md — what the user wants`,
      `- ${taskDir}/RESEARCH.md — findings, context, open questions`,
      "",
      "These are optional — only produce them if the user asks.",
      "When done, call /pp:done.",
    ].join("\n");
  }

  return [
    "[PI-PI — BRAINSTORM PHASE]",
    `Task: ${taskDescription}`,
    "",
    "Your job is to produce USER_REQUEST.md and RESEARCH.md — complete enough that",
    "downstream agents can work without re-exploring the codebase or re-interviewing the user.",
    "",
    "Steps:",
    "1. Clarify requirements with the user if anything is ambiguous",
    '2. Spawn explore subagents via Agent(subagent_type="Explore", ...) for codebase research',
    '3. Spawn librarian subagents via Agent(subagent_type="Librarian", ...) for external docs/library research',
    "4. Ask the user follow-up questions as needed",
    "5. Write findings into RESEARCH.md as results come back — don't wait for all subagents",
    "",
    "IMPORTANT: Always specify subagent_type. Use Explore for codebase, Librarian for external docs.",
    "",
    "Produce two files:",
    `- ${taskDir}/USER_REQUEST.md — clear statement of what needs to be done`,
    `- ${taskDir}/RESEARCH.md — codebase findings, architecture notes, constraints, open questions`,
    "",
    "Do NOT modify any files except .md files in the task directory.",
    "When both files are produced and thorough, call /pp:next.",
  ].join("\n");
}
