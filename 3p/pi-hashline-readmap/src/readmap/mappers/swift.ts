/**
 * Swift mapper using regex-based extraction.
 *
 * Extracts classes, actors, structs, enums, protocols, extensions, functions,
 * and deinit lifecycle blocks.
 * No external dependencies — pure regex with brace-depth tracking.
 */
import { readFile, stat } from "node:fs/promises";
import type { FileMap, FileSymbol } from "../types.js";

import { DetailLevel, SymbolKind } from "../enums.js";
export const MAPPER_VERSION = 1;

const SWIFT_CONTAINER_DECL_RE =
  /^(?:\s*)(?:@\w+\s+)*(?:(?:public|private|internal|open|fileprivate)\s+)?(?:(?:final|static|override|class|mutating|nonmutating)\s+)*(class|struct|enum|protocol|extension|actor)\s+(\w+)/;
const SWIFT_FUNC_DECL_RE =
  /^(?:\s*)(?:@\w+\s+)*(?:(?:public|private|internal|open|fileprivate)\s+)?(?:(?:final|static|override|class|mutating|nonmutating)\s+)*func\s+([^\s(<]+)/;
const SWIFT_DEINIT_DECL_RE =
  /^(?:\s*)(?:@\w+\s+)*(?:(?:public|private|internal|open|fileprivate)\s+)?(?:(?:final|static|override|class|mutating|nonmutating)\s+)*deinit\b/;
interface SwiftDeclaration {
  keyword: string;
  name: string;
  signature: string;
}
function countChar(s: string, ch: string): number {
  let n = 0;
  for (const c of s) if (c === ch) n++;
  return n;
}
function parseSwiftDeclaration(line: string): SwiftDeclaration | null {
  const containerMatch = line.match(SWIFT_CONTAINER_DECL_RE);
  if (containerMatch) {
    const [, keyword, name] = containerMatch;
    return {
      keyword,
      name,
      signature: line.replace(/\{.*$/, "").trim(),
    };
  }
  if (SWIFT_DEINIT_DECL_RE.test(line)) {
    return {
      keyword: "deinit",
      name: "deinit",
      signature: "deinit",
    };
  }
  const funcMatch = line.match(SWIFT_FUNC_DECL_RE);
  if (funcMatch) {
    const [, name] = funcMatch;
    return {
      keyword: "func",
      name,
      signature: line.replace(/\{.*$/, "").trim(),
    };
  }

  return null;
}

/**
 * Generate a file map for a Swift file.
 */
export async function swiftMapper(
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
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNum = i + 1;
      const trimmed = line.trim();
      if (trimmed.startsWith("//")) continue;
      const decl = parseSwiftDeclaration(trimmed);
      if (decl) {
        const { keyword, name, signature } = decl;
        let kind: SymbolKind;
        switch (keyword) {
          case "class":
          case "struct":
          case "extension":
          case "actor":
            kind = SymbolKind.Class;
            break;
          case "enum":
            kind = SymbolKind.Enum;
            break;
          case "protocol":
            kind = SymbolKind.Interface;
            break;
          case "func":
          case "deinit":
            kind = braceDepth > 0 ? SymbolKind.Method : SymbolKind.Function;
            break;
          default:
            kind = SymbolKind.Unknown;
        }
        const sym: FileSymbol = {
          name,
          kind,
          startLine: lineNum,
          endLine: lineNum,
          signature,
        };
        const isChild = declStack.length > 0 && (keyword === "func" || keyword === "deinit");
        const parentEntry = isChild ? declStack[declStack.length - 1] : null;
        const openBraces = countChar(line, "{");
        const closeBraces = countChar(line, "}");
        if (openBraces > closeBraces) {
          declStack.push({ symbol: sym, startDepth: braceDepth });
        } else {
          sym.endLine = lineNum;
        }
        if (isChild && parentEntry) {
          if (!parentEntry.symbol.children) parentEntry.symbol.children = [];
          parentEntry.symbol.children.push(sym);
        } else {
          symbols.push(sym);
        }

        braceDepth += openBraces - closeBraces;
        continue;
      }

      const openBraces = countChar(line, "{");
      const closeBraces = countChar(line, "}");
      braceDepth += openBraces - closeBraces;
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
    for (const item of declStack) {
      item.symbol.endLine = totalLines;
    }

    if (symbols.length === 0) return null;

    return {
      path: filePath,
      totalLines,
      totalBytes,
      language: "Swift",
      symbols,
      imports: [],
      detailLevel: DetailLevel.Full,
    };
  } catch (error) {
    if (signal?.aborted) return null;
    console.error(`Swift mapper failed: ${error}`);
    return null;
  }
}
