/**
 * Shell/Bash mapper using regex-based extraction.
 *
 * Extracts functions (both styles), aliases, and exported variables.
 * Handles heredocs gracefully — content inside heredocs is not parsed.
 * No external dependencies — pure regex with brace-depth tracking.
 */
import { readFile, stat } from "node:fs/promises";

import type { FileMap, FileSymbol } from "../types.js";

import { DetailLevel, SymbolKind } from "../enums.js";
export const MAPPER_VERSION = 1;

// function name() { ... } or function name { ... }
const FUNC_KEYWORD_RE = /^\s*function\s+(\w+)\s*(?:\(\s*\))?\s*(?:\{.*)?$/;

// name() { ... }
const FUNC_PARENS_RE = /^\s*(\w+)\s*\(\s*\)\s*(?:\{.*)?$/;

// alias name='...' or alias name="..."
const ALIAS_RE = /^\s*alias\s+(\w[\w-]*)=/;

// export NAME=... (uppercase convention for exported vars)
const EXPORT_RE = /^\s*export\s+([A-Za-z_]\w*)=/;

// Heredoc start: <<EOF, <<'EOF', <<"EOF", <<-EOF
const HEREDOC_START_RE = /<<-?\s*['"]?(\w+)['"]?\s*$/;

function countChar(s: string, ch: string): number {
  let n = 0;
  for (const c of s) if (c === ch) n++;
  return n;
}

/**
 * Generate a file map for a Shell/Bash file.
 */
export async function shellMapper(
  filePath: string,
  signal?: AbortSignal,
): Promise<FileMap | null> {
  try {
    const stats = await stat(filePath);
    const totalBytes = stats.size;

    const content = await readFile(filePath, "utf8");

    if (signal?.aborted) return null;

    const lines = content.split(/\r?\n/);
    const totalLines = lines.length;
    const symbols: FileSymbol[] = [];

    let braceDepth = 0;
    const declStack: { symbol: FileSymbol; startDepth: number }[] = [];
    let heredocDelimiter: string | null = null;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNum = i + 1;
      const trimmed = line.trim();

      // Handle heredoc: skip lines until we find the closing delimiter
      if (heredocDelimiter !== null) {
        if (trimmed === heredocDelimiter) {
          heredocDelimiter = null;
        }
        continue;
      }

      // Skip comments and empty lines for symbol detection
      if (trimmed.startsWith("#") || trimmed === "") {
        continue;
      }

      // Check for heredoc start (on any line, including inside functions)
      const heredocMatch = line.match(HEREDOC_START_RE);
      if (heredocMatch) {
        heredocDelimiter = heredocMatch[1];
        // Still process this line for function detection before entering heredoc mode
      }

      // Try function with 'function' keyword: function name() { or function name {
      let funcMatch = trimmed.match(FUNC_KEYWORD_RE);
      if (funcMatch) {
        const name = funcMatch[1];
        const sym: FileSymbol = {
          name,
          kind: SymbolKind.Function,
          startLine: lineNum,
          endLine: lineNum,
          signature: trimmed.replace(/\{.*$/, "").trim(),
        };

        const openBraces = countChar(line, "{");
        const closeBraces = countChar(line, "}");

        if (openBraces > closeBraces) {
          declStack.push({ symbol: sym, startDepth: braceDepth });
        } else {
          sym.endLine = lineNum;
        }

        symbols.push(sym);
        braceDepth += openBraces - closeBraces;
        continue;
      }

      // Try name() { style function
      funcMatch = trimmed.match(FUNC_PARENS_RE);
      if (funcMatch) {
        // Exclude shell builtins and common keywords that could match
        const name = funcMatch[1];
        if (!isShellKeyword(name)) {
          const sym: FileSymbol = {
            name,
            kind: SymbolKind.Function,
            startLine: lineNum,
            endLine: lineNum,
            signature: trimmed.replace(/\{.*$/, "").trim(),
          };

          const openBraces = countChar(line, "{");
          const closeBraces = countChar(line, "}");

          if (openBraces > closeBraces) {
            declStack.push({ symbol: sym, startDepth: braceDepth });
          } else {
            sym.endLine = lineNum;
          }

          symbols.push(sym);
          braceDepth += openBraces - closeBraces;
          continue;
        }
      }

      // Try alias
      const aliasMatch = trimmed.match(ALIAS_RE);
      if (aliasMatch) {
        symbols.push({
          name: aliasMatch[1],
          kind: SymbolKind.Variable,
          startLine: lineNum,
          endLine: lineNum,
          signature: trimmed,
        });
        continue;
      }

      // Try export
      const exportMatch = trimmed.match(EXPORT_RE);
      if (exportMatch) {
        const name = exportMatch[1];
        let endLine = lineNum;

        // Check for unclosed quote spanning multiple lines
        const eqIdx = trimmed.indexOf("=");
        const afterEquals = trimmed.slice(eqIdx + 1);
        let quoteChar: string | null = null;
        if (afterEquals.startsWith('"')) quoteChar = '"';
        else if (afterEquals.startsWith("'")) quoteChar = "'";

        if (quoteChar) {
          // Check if the opening quote is closed on this line
          const rest = afterEquals.slice(1); // everything after opening quote
          if (!rest.includes(quoteChar)) {
            // Unclosed quote — scan forward for closing quote
            for (let j = i + 1; j < lines.length; j++) {
              if (lines[j].includes(quoteChar)) {
                endLine = j + 1; // 1-indexed
                i = j; // advance main loop past continuation lines
                break;
              }
            }
          }
        }
        symbols.push({
          name,
          kind: SymbolKind.Variable,
          startLine: lineNum,
          endLine,
          signature: trimmed,
        });
        continue;
      }

      // Track braces for non-declaration lines
      const openBraces = countChar(line, "{");
      const closeBraces = countChar(line, "}");
      braceDepth += openBraces - closeBraces;

      // Pop closed declarations
      while (declStack.length > 0) {
        const top = declStack[declStack.length - 1];
        if (braceDepth <= top.startDepth) {
          top.symbol.endLine = lineNum;
          declStack.pop();
        } else {
          break;
        }
      }
    }

    // Close any remaining open declarations
    for (const item of declStack) {
      item.symbol.endLine = totalLines;
    }

    if (symbols.length === 0) return null;

    return {
      path: filePath,
      totalLines,
      totalBytes,
      language: "Shell",
      symbols,
      imports: [],
      detailLevel: DetailLevel.Full,
    };
  } catch (error) {
    if (signal?.aborted) return null;
    console.error(`Shell mapper failed: ${error}`);
    return null;
  }
}

/** Shell keywords that look like function names but aren't */
function isShellKeyword(name: string): boolean {
  const keywords = new Set([
    "if", "then", "else", "elif", "fi",
    "for", "while", "until", "do", "done",
    "case", "esac", "select", "in",
    "time", "coproc",
  ]);
  return keywords.has(name);
}
