import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { registerReadTool } from "./src/read.js";
import { registerEditTool } from "./src/edit.js";
import { registerGrepTool } from "./src/grep.js";
import { registerSgTool, isSgAvailable } from "./src/sg.js";
import { registerNuTool } from "./src/nu.js";
import { registerWriteTool } from "./src/write.js";
import { registerLsTool } from "./src/ls.js";
import { registerFindTool } from "./src/find.js";
import { filterBashOutput } from "./src/rtk/bash-filter.js";
import { stripAnsi } from "./src/rtk/ansi.js";
import {
  consumeDoomLoopWarning,
  createDoomLoopState,
  formatDoomLoopMessage,
  recordToolCall,
} from "./src/doom-loop.js";

function isBashToolResult(event: unknown): event is {
  toolName: string;
  toolCallId: string;
  input: { command?: string };
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
  details?: unknown;
} {
  return !!event && typeof event === "object" && (event as { toolName?: unknown }).toolName === "bash";
}

export {
  HASHLINE_TOOL_PTC_POLICY,
  getHashlineToolPtcPolicy,
} from "./src/ptc-tool-policy.js";
export type {
  HashlineToolDefaultExposure,
  HashlineToolMutability,
  HashlineToolName,
  HashlineToolPtcPolicy,
  HashlineToolPtcPolicyEntry,
} from "./src/ptc-tool-policy.js";

const BASH_FILTER_ENABLED = true;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

function buildRtkNotice(
  info: {
    originalBytes: number;
    outputBytes: number;
    compressionRatio: number;
    technique: string;
    bypassedBy?: string;
  },
  command: string,
  outputIsEmpty: boolean,
): string | null {
  if (info.bypassedBy !== undefined) return null;
  if (outputIsEmpty) return null;
  if (info.originalBytes <= 2000) return null;
  if (info.compressionRatio >= 0.5) return null;
  const pct = Math.round((1 - info.compressionRatio) * 100);
  return `[RTK: compressed ${info.technique} output ${formatBytes(info.originalBytes)} → ${formatBytes(info.outputBytes)} (${pct}% saved). Use \`PI_RTK_BYPASS=1 ${command}\` to see full output.]`;
}

export default function piHashlineReadmapExtension(pi: ExtensionAPI): void {
  const readTurns = new Map<string, number>();
  let currentTurn = 0;
  const doomLoopState = createDoomLoopState();
  const noteRead = (absolutePath: string) => {
    currentTurn += 1;
    readTurns.set(absolutePath, currentTurn);
  };
  const wasReadInSession = (absolutePath: string) => readTurns.has(absolutePath);

  const readTool = registerReadTool(pi, { onSuccessfulRead: noteRead });
  const editTool = registerEditTool(pi, { wasReadInSession });
  const sgAvailable = isSgAvailable();
  const astSearchGuideline = sgAvailable
    ? 'Use `ast_search` for structural code patterns (function calls, imports, JSX). Use `grep` for text matching.'
    : 'For AST-aware structural code search (function calls, imports, JSX elements), install ast-grep: `brew install ast-grep`';

  const grepTool = registerGrepTool(pi, { astSearchGuideline, onFileAnchored: noteRead });
  const sgTool = registerSgTool(pi, { onFileAnchored: noteRead });
  const nuTool = registerNuTool(pi);
  const writeTool = registerWriteTool(pi, { onFileAnchored: noteRead });
  const lsTool = registerLsTool(pi);
  const findTool = registerFindTool(pi);
  const toolExecutors = {
    read: readTool,
    edit: editTool,
    grep: grepTool,
    ast_search: sgTool,
    write: writeTool,
    ls: lsTool,
    find: findTool,
    ...(nuTool ? { nu: nuTool } : {}),
  };

  (globalThis as any).__hashlineToolExecutors = toolExecutors;
  pi.events.emit("hashline:tool-executors", toolExecutors);

  pi.on("tool_call", (event: any) => {
    recordToolCall(
      doomLoopState,
      event.toolName,
      event.toolCallId,
      (event.input ?? {}) as Record<string, unknown>,
    );
    return undefined;
  });

  pi.on("tool_result", (event: any) => {
    const doomLoop = consumeDoomLoopWarning(doomLoopState, event.toolCallId);
    if (!isBashToolResult(event)) {
      if (!doomLoop || !Array.isArray(event.content)) {
        return undefined;
      }
      const content = [...event.content];
      const prefix = `${formatDoomLoopMessage(doomLoop)}\n\n---\n`;
      let textIndex = -1;
      for (let i = 0; i < content.length; i++) {
        const item = content[i] as { type?: unknown; text?: unknown };
        if (item.type === "text" && typeof item.text === "string") {
          textIndex = i;
          break;
        }
      }
      if (textIndex >= 0) {
        const item = content[textIndex] as { type: "text"; text: string };
        content[textIndex] = { ...item, text: `${prefix}${item.text}` };
      } else {
        content.unshift({ type: "text" as const, text: prefix });
      }
      return {
        content,
        details: event.details,
        isError: event.isError,
      };
    }
    const originalText = Array.isArray(event.content)
      ? (event.content as Array<{ type?: unknown; text?: unknown }>)
          .filter((c): c is { type: "text"; text: string } => c.type === "text" && typeof c.text === "string")
          .map((c) => c.text)
          .join("\n")
      : "";

    const command = (event.input as { command?: string }).command ?? "";
    const applyWarning = (body: string): string => {
      if (!doomLoop) return body;
      const prefix = `${formatDoomLoopMessage(doomLoop)}\n\n---\n`;
      return `${prefix}${body}`;
    };
    if (!BASH_FILTER_ENABLED) {
      const stripped = stripAnsi(originalText);
      const text = applyWarning(stripped);
      if (text === originalText) return undefined;
      return { content: [{ type: "text" as const, text }] };
    }
    const { output, savedChars, info } = filterBashOutput(command, originalText);
    if (process.env.PI_RTK_SAVINGS === "1") {
      process.stderr.write(`[RTK] Saved ${savedChars} chars (${command})\n`);
    }
    const notice = buildRtkNotice(info, command, output === "");
    const body = notice ? `${notice}\n${output}` : output;
    const existingDetails =
      event.details && typeof event.details === "object" ? (event.details as Record<string, unknown>) : {};
    return {
      content: [{ type: "text" as const, text: applyWarning(body) }],
      details: { ...existingDetails, compressionInfo: info }
    };
  });
}
