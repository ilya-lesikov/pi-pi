import * as Diff from "diff";
import { execFile } from "node:child_process";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";

export type EditClassification = "no-op" | "whitespace-only" | "semantic" | "mixed";

export interface EditClassifyResult {
  classification: EditClassification;
}

export function classifyEdit(oldContent: string, newContent: string): EditClassifyResult {
  if (oldContent === newContent) {
    return { classification: "no-op" };
  }

  const oldLines = oldContent.split("\n");
  const newLines = newContent.split("\n");

  // When line counts match, do pairwise comparison
  if (oldLines.length === newLines.length) {
    let hasWhitespaceChange = false;
    let hasSemanticChange = false;
    for (let i = 0; i < oldLines.length; i++) {
      if (oldLines[i] === newLines[i]) continue;
      if (oldLines[i].trim() === newLines[i].trim()) {
        hasWhitespaceChange = true;
      } else {
        hasSemanticChange = true;
      }
    }
    if (hasSemanticChange && hasWhitespaceChange) return { classification: "mixed" };
    if (hasWhitespaceChange) return { classification: "whitespace-only" };
    return { classification: "semantic" };
  }

  // When line counts differ, use diff library to find changes
  const parts = Diff.diffLines(oldContent, newContent);
  let hasWhitespaceChange = false;
  let hasSemanticChange = false;

  for (const part of parts) {
    if (!part.added && !part.removed) continue;

    const lines = part.value.split("\n");
    if (lines[lines.length - 1] === "") lines.pop();

    for (const line of lines) {
      if (line.trim() === "") {
        hasWhitespaceChange = true;
      } else {
        hasSemanticChange = true;
      }
    }
  }

  if (hasSemanticChange && hasWhitespaceChange) return { classification: "mixed" };
  if (hasWhitespaceChange) return { classification: "whitespace-only" };
  return { classification: "semantic" };
}

let difftCachedResult: boolean | null = null;

export function _resetDifftCache(): void {
  difftCachedResult = null;
}

export async function isDifftAvailable(): Promise<boolean> {
  if (difftCachedResult !== null) return difftCachedResult;

  return new Promise<boolean>((resolve) => {
    execFile("which", ["difft"], (err) => {
      difftCachedResult = !err;
      resolve(difftCachedResult);
    });
  });
}

export interface DifftClassifyResult {
  classification: EditClassification;
  movedBlocks: number;
}

function getChunkSideText(side: any): string {
  if (!side || typeof side !== "object") return "";
  if (!Array.isArray(side.changes)) return "";
  return side.changes
    .map((change: any) => (change && typeof change.content === "string" ? change.content : ""))
    .join("");
}

function getChunkOnlySideSignature(chunk: any[]): { side: "lhs" | "rhs"; text: string } | null {
  let hasLhs = false;
  let hasRhs = false;
  let text = "";

  for (const entry of chunk) {
    if (entry?.lhs) {
      hasLhs = true;
      text += getChunkSideText(entry.lhs);
    }
    if (entry?.rhs) {
      hasRhs = true;
      text += getChunkSideText(entry.rhs);
    }
  }

  if (hasLhs === hasRhs) return null;
  return { side: hasLhs ? "lhs" : "rhs", text };
}

export function parseDifftJson(json: any): DifftClassifyResult | null {
  if (!json || typeof json !== "object" || !("status" in json)) return null;

  if (json.status === "unchanged") {
    return { classification: "whitespace-only", movedBlocks: 0 };
  }

  if (json.status !== "changed" || !Array.isArray(json.chunks)) {
    return null;
  }

  const lhsOnlyChunkTexts: string[] = [];
  const rhsOnlyChunkTexts: string[] = [];
  for (const chunk of json.chunks) {
    if (!Array.isArray(chunk)) continue;
    const signature = getChunkOnlySideSignature(chunk);
    if (!signature) continue;
    if (signature.side === "lhs") lhsOnlyChunkTexts.push(signature.text);
    if (signature.side === "rhs") rhsOnlyChunkTexts.push(signature.text);
  }

  const remainingRhs = new Map<string, number>();
  for (const text of rhsOnlyChunkTexts) {
    remainingRhs.set(text, (remainingRhs.get(text) ?? 0) + 1);
  }

  let movedBlocks = 0;
  for (const text of lhsOnlyChunkTexts) {
    const count = remainingRhs.get(text) ?? 0;
    if (count <= 0) continue;
    movedBlocks++;
    if (count === 1) remainingRhs.delete(text);
    else remainingRhs.set(text, count - 1);
  }

  return { classification: "semantic", movedBlocks };

  return { classification: "semantic", movedBlocks };
}

export async function runDifftastic(
  oldContent: string,
  newContent: string,
  fileExtension: string,
): Promise<DifftClassifyResult | null> {
  const available = await isDifftAvailable();
  if (!available) return null;

  let tempDir: string | null = null;
  try {
    tempDir = mkdtempSync(resolve(tmpdir(), "pi-difft-"));
    const oldPath = resolve(tempDir, `old.${fileExtension}`);
    const newPath = resolve(tempDir, `new.${fileExtension}`);
    writeFileSync(oldPath, oldContent, "utf-8");
    writeFileSync(newPath, newContent, "utf-8");

    const stdout = await new Promise<string>((resolve, reject) => {
      execFile(
        "difft",
        ["--display=json", oldPath, newPath],
        { env: { ...process.env, DFT_UNSTABLE: "yes" }, timeout: 10_000 },
        (err, stdout) => {
          if (err) return reject(err);
          resolve(stdout);
        },
      );
    });

    const json = JSON.parse(stdout);
    return parseDifftJson(json);
  } catch {
    return null;
  } finally {
    if (tempDir) {
      try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }
}
