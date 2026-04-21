import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative } from "node:path";
import { resolveToCwd } from "./path-utils.js";
import { ensureHashInit, formatHashlineDisplay } from "./hashline.js";
import { buildPtcError, buildPtcLine, buildPtcWarning, type PtcLine, type PtcWarning } from "./ptc-value.js";
import { looksLikeBinary } from "./binary-detect.js";
import { getOrGenerateMap } from "./map-cache.js";
import { formatFileMapWithBudget } from "./readmap/formatter.js";

const MAX_LINES = 2000;
const MAX_BYTES = 50 * 1024;
const WRITE_PROMPT = readFileSync(new URL("../prompts/write.md", import.meta.url), "utf-8").trim();
const WRITE_DESC = WRITE_PROMPT.split(/\n\s*\n/, 1)[0]?.trim() ?? WRITE_PROMPT;

export interface WriteResult {
  text: string;
  warnings: string[];
  ptcValue: {
    tool: "write";
    path: string;
    lines: PtcLine[];
    warnings: PtcWarning[];
    map?: { appended: boolean };
  };
}

export interface WriteToolOptions {
  onFileAnchored?: (absolutePath: string) => void;
}

type MappedFsError = {
  code: "permission-denied" | "path-is-directory" | "fs-error";
  message: string;
  includeMeta: boolean;
};

function mapFsWriteError(err: any, path: string): MappedFsError {
  const phase: "mkdir" | "write" | undefined = err?.__phase;
  const fsCode = err?.code as string | undefined;

  if (fsCode === "EACCES" || fsCode === "EPERM") {
    return {
      code: "permission-denied",
      message: `Permission denied — cannot write: ${path}`,
      includeMeta: false,
    };
  }
  if (fsCode === "EISDIR") {
    return {
      code: "path-is-directory",
      message: `Path is a directory — cannot overwrite: ${path}`,
      includeMeta: false,
    };
  }
  if (fsCode === "ENOENT" && phase === "mkdir") {
    return {
      code: "fs-error",
      message: `Cannot create parent directories for ${path}: ${err?.message ?? String(err)}`,
      includeMeta: true,
    };
  }
  if (fsCode === "ENOSPC") {
    return {
      code: "fs-error",
      message: `No space left on device — cannot write: ${path}`,
      includeMeta: true,
    };
  }
  if (fsCode === "EROFS") {
    return {
      code: "fs-error",
      message: `Read-only filesystem — cannot write: ${path}`,
      includeMeta: true,
    };
  }
  return {
    code: "fs-error",
    message: `Error writing ${path}: ${err?.message ?? String(err)}`,
    includeMeta: true,
  };
}

export async function executeWrite(opts: {
  path: string;
  content: string;
  map?: boolean;
  cwd?: string;
}): Promise<WriteResult> {
  await ensureHashInit();

  const { path: filePath, content, map: requestMap, cwd } = opts;

  // Create parent directories
  try {
    mkdirSync(dirname(filePath), { recursive: true });
  } catch (err: any) {
    err.__phase = "mkdir";
    throw err;
  }
  // Write file
  try {
    writeFileSync(filePath, content, "utf-8");
  } catch (err: any) {
    err.__phase = "write";
    throw err;
  }

  const warnings: string[] = [];
  const ptcWarnings: PtcWarning[] = [];

  // Binary detection
  if (looksLikeBinary(Buffer.from(content, "utf-8"))) {
    warnings.push("File content appears to be binary.");
    ptcWarnings.push(buildPtcWarning("binary-content", "File content appears to be binary."));
    return {
      text: `Wrote ${filePath}\n⚠️ File content appears to be binary — hashlines not generated.`,
      warnings,
      ptcValue: {
        tool: "write",
        path: filePath,
        lines: [],
        warnings: ptcWarnings,
      },
    };
  }

  // Compute hashlines
  const rawLines = content.split("\n");
  const ptcLines: PtcLine[] = [];
  const displayLines: string[] = [];

  for (let i = 0; i < rawLines.length; i++) {
    const lineNum = i + 1;
    const ptcLine = buildPtcLine(lineNum, rawLines[i]);
    ptcLines.push(ptcLine);
    displayLines.push(formatHashlineDisplay(lineNum, rawLines[i]));
  }

  let text = displayLines.join("\n");
  if (rawLines.length > MAX_LINES) {
    text = displayLines.slice(0, MAX_LINES).join("\n");
    text += `\n[… ${rawLines.length - MAX_LINES} more lines not shown — full anchors in ptcValue]`;
  }
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > MAX_BYTES) {
    text = Buffer.from(text, "utf8").subarray(0, MAX_BYTES).toString("utf8");
    text += "\n[… output truncated at 50 KB — full anchors in ptcValue]";
  }

  // Optional structural map
  let mapAppended = false;
  if (requestMap) {
    try {
      const fileMap = await getOrGenerateMap(filePath);
      if (fileMap) {
        const mapText = formatFileMapWithBudget(fileMap);
        if (mapText) {
          text += "\n\n" + mapText;
          mapAppended = true;
        }
      }
    } catch {
      // Map generation failure is non-fatal
    }
  }

  const displayPath = cwd ? relative(cwd, filePath) || filePath : filePath;

  return {
    text,
    warnings,
    ptcValue: {
      tool: "write",
      path: displayPath,
      lines: ptcLines,
      warnings: ptcWarnings,
      ...(requestMap !== undefined ? { map: { appended: mapAppended } } : {}),
    },
  };
}

export function registerWriteTool(pi: ExtensionAPI, options: WriteToolOptions = {}) {
  const tool = {
    name: "write",
    label: "write",
    description: WRITE_DESC,
    parameters: Type.Object({
      path: Type.String({ description: "Path to the file to write (relative or absolute)" }),
      content: Type.String({ description: "Content to write to the file" }),
      map: Type.Optional(Type.Boolean({ description: "Append structural map to output" })),
    }),
    async execute(_toolCallId: string, params: { path: string; content: string; map?: boolean }, _signal: AbortSignal | undefined, _onUpdate: any, ctx: any) {
      const cwd = ctx?.cwd ?? process.cwd();
      const absolutePath = resolveToCwd(params.path, cwd);
      let result: WriteResult;
      try {
        result = await executeWrite({
          path: absolutePath,
          content: params.content,
          map: params.map,
          cwd,
        });
      } catch (err: any) {
        const mapped = mapFsWriteError(err, absolutePath);
        return {
          content: [{ type: "text" as const, text: mapped.message }],
          isError: true,
          details: {
            ptcValue: {
              tool: "write" as const,
              path: absolutePath,
              lines: [] as PtcLine[],
              warnings: [] as PtcWarning[],
              ok: false,
              error: buildPtcError(
                mapped.code,
                mapped.message,
                undefined,
                mapped.includeMeta ? { fsCode: err?.code, fsMessage: err?.message } : undefined,
              ),
            },
            warnings: [] as string[],
          },
        };
      }

      if (result.ptcValue.lines.length > 0) {
        options.onFileAnchored?.(absolutePath);
      }

      // Lift binary-content signal into a fatal ptcValue.error envelope so
      // downstream consumers get the same taxonomy shape as every other tool.
      // The existing PtcWarning entry is preserved on ptcValue.warnings for
      // backward compatibility (see AC 12 — warnings namespace alignment).
      const binaryWarning = result.ptcValue.warnings.find((w) => w.code === "binary-content");
      if (binaryWarning) {
        return {
          content: [{ type: "text" as const, text: result.text }],
          isError: true,
          details: {
            ptcValue: {
              ...result.ptcValue,
              ok: false,
              error: buildPtcError("binary-content", binaryWarning.message),
            },
            warnings: result.warnings,
          },
        };
      }

      return {
        content: [{ type: "text" as const, text: result.text }],
        details: {
          ptcValue: result.ptcValue,
          warnings: result.warnings,
        },
      };
    },
    renderCall(args: any, theme: any) {
      const { path } = args as { path: string };
      const label = theme.fg("toolTitle", "✏️ write");
      return new Text(`${label} ${theme.fg("muted", path)}`, 0, 0);
    },
    renderResult(result: any, _options: any, theme: any) {
      const output = result.content[0]?.type === "text"
        ? (result.content[0] as { type: "text"; text: string }).text
        : "";
      const lineCount = output.split("\n").filter((l: string) => /^\d+:[0-9a-f]{3}\|/.test(l)).length;
      const summary = lineCount > 0 ? `${lineCount} lines written` : "written";
      return new Text(theme.fg("toolOutput", summary), 0, 0);
    },
  };
  pi.registerTool(tool);
  return tool;
}
