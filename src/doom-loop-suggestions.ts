// Static per-tool suggestion table used by the doom-loop warning formatter.
//
// UPKEEP: these strings are static and must be maintained alongside any
// tool-schema changes in src/read.ts, src/edit.ts, src/grep.ts, src/sg.ts,
// src/find.ts, and src/ls.ts. When a tool adds/renames a parameter, update
// the matching entry below so the suggestion remains accurate.

export const SUGGESTIONS: Record<string, readonly string[]> = {
  grep: [
    "try ignoreCase: true",
    "try literal: true if pattern has special characters",
    "try a narrower glob or path",
    "switch to ast_search for structural patterns",
    "try summary: true to scope broader",
  ],
  read: [
    "if searching for a symbol, use symbol: or map: true",
    "if file is large, try offset + limit",
    "if file keeps being read identically, the content may already be what you expect",
  ],
  edit: [
    "if hash-mismatch keeps firing, re-read the file",
    "if no-op keeps firing, your new_text equals current content",
    "verify the anchor came from the most recent read/grep/ast_search",
  ],
  ast_search: [
    'check the lang parameter matches file type (e.g. lang: "tsx" for JSX)',
    "simplify the pattern with $_ or $$$ wildcards",
    "verify ast-grep is installed",
  ],
  find: [
    "try a looser glob",
    'try type: "any"',
    "try a different path",
  ],
  ls: [
    "try a different path",
    "remove the glob filter",
  ],
};

export const GENERIC_SUGGESTION = "try a different approach — the repeating call is not making progress";
