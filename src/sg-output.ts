import type { PtcLine, PtcRange } from "./ptc-value.js";

export interface SgOutputFile {
  displayPath: string;
  path: string;
  ranges: PtcRange[];
  lines: PtcLine[];
}

export interface BuildSgOutputInput {
  pattern: string;
  files: SgOutputFile[];
}

export interface SgOutputResult {
  text: string;
  ptcValue: {
    tool: "ast_search";
    files: Array<{
      path: string;
      ranges: PtcRange[];
      lines: PtcLine[];
    }>;
  };
}

export function buildSgOutput(input: BuildSgOutputInput): SgOutputResult {
  if (input.files.length === 0) {
    return {
      text: `No matches found for pattern: ${input.pattern}`,
      ptcValue: {
        tool: "ast_search",
        files: [],
      },
    };
  }

  const blocks: string[] = [];
  for (const file of input.files) {
    blocks.push(`--- ${file.displayPath} ---`);
    for (const line of file.lines) {
      blocks.push(`>>${line.anchor}|${line.display}`);
    }
  }

  return {
    text: blocks.join("\n"),
    ptcValue: {
      tool: "ast_search",
      files: input.files.map((file) => ({
        path: file.path,
        ranges: file.ranges.map((range) => ({ ...range })),
        lines: file.lines.map((line) => ({ ...line })),
      })),
    },
  };
}
