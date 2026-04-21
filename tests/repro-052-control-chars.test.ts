/**
 * Repro #052: read/grep/sg outputs with raw control characters can break
 * subsequent edit tool calls via invalid JSON.
 *
 * Files containing raw ASCII control characters (U+0000–U+001F, excluding
 * tab/newline/CR) are surfaced verbatim in tool output. If the model copies
 * those bytes into a later tool-call JSON string (e.g. an edit anchor or
 * new_text), JSON parsing fails with:
 *   "Bad control character in string literal in JSON at position …"
 *
 * These tests FAIL before the fix is applied and PASS afterwards.
 */

import { describe, it, expect } from "vitest";
import { writeFileSync, mkdtempSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";

// helpers

async function callReadTool(params: { path: string; offset?: number; limit?: number }) {
  const { registerReadTool } = await import("../src/read.js");
  let capturedTool: any = null;
  const mockPi = { registerTool(def: any) { capturedTool = def; } };
  registerReadTool(mockPi as any);
  if (!capturedTool) throw new Error("read tool was not registered");
  return capturedTool.execute("test", params, new AbortController().signal, () => {}, { cwd: process.cwd() });
}

async function callGrepTool(params: { pattern: string; path: string; literal?: boolean }) {
  const { registerGrepTool } = await import("../src/grep.js");
  let capturedTool: any = null;
  const mockPi = { registerTool(def: any) { capturedTool = def; } };
  registerGrepTool(mockPi as any);
  if (!capturedTool) throw new Error("grep tool was not registered");
  return capturedTool.execute("test", params, new AbortController().signal, () => {}, { cwd: process.cwd() });
}

function getTextContent(result: any): string {
  return result.content.find((c: any) => c.type === "text")?.text ?? "";
}

/** Control characters that are illegal unescaped in JSON strings */
const CONTROL_CHAR_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f]/;

// ── test fixture ─────────────────────────────────────────────────────────────

function makeControlCharFile(): string {
  const dir = mkdtempSync(resolve(tmpdir(), "pi-repro-052-"));
  const filePath = resolve(dir, "control-chars.txt");
  // Embed: SOH (U+0001), STX (U+0002), BEL (U+0007), US (U+001F)
  const content =
    "normal first line\n" +
    "line with \x01 SOH (start-of-heading)\n" +
    "line with \x02 STX (start-of-text)\n" +
    "line with \x07 BEL (bell)\n" +
    "line with \x1f US (unit-separator)\n" +
    "normal last line\n";
  writeFileSync(filePath, content, "utf-8");
  return filePath;
}

// ── tests ────────────────────────────────────────────────────────────────────

describe("Bug #052: control characters in read/grep output", () => {
  it("read tool output must NOT contain raw control characters", async () => {
    const filePath = makeControlCharFile();
    const result = await callReadTool({ path: filePath });
    const text = getTextContent(result);

    // The output currently contains raw control chars — this assertion FAILS before the fix
    expect(
      CONTROL_CHAR_RE.test(text),
      "read output contains raw control characters that would break JSON parsing"
    ).toBe(false);
  });

  it("grep tool output must NOT contain raw control characters", async () => {
    const filePath = makeControlCharFile();
    // Search for something that matches lines with control chars
    const result = await callGrepTool({ pattern: "line with", path: filePath, literal: true });
    const text = getTextContent(result);

    // The output currently contains raw control chars — this assertion FAILS before the fix
    expect(
      CONTROL_CHAR_RE.test(text),
      "grep output contains raw control characters that would break JSON parsing"
    ).toBe(false);
  });

  it("read output when serialized and re-parsed as JSON preserves content", async () => {
    const filePath = makeControlCharFile();
    const result = await callReadTool({ path: filePath });
    const text = getTextContent(result);

    // Simulate what the runtime does: embed tool output text in a JSON message
    // If raw control chars are present, JSON.parse on the re-serialized object
    // would fail or produce garbled output when the MODEL emits those chars raw.
    // We simulate model behavior: model copies verbatim bytes into a JSON string.
    let jsonParseError: Error | null = null;
    try {
      // Construct JSON the way a model would — newlines escaped, control chars raw (before fix)
      // Model copies text into JSON — newlines must be escaped manually since
      // they're valid in hashlined output but illegal in raw JSON strings.
      const rawJson = `{"new_text": "${text.replace(/\n/g, "\\n")}"}`;
      JSON.parse(rawJson);
    } catch (e) {
      jsonParseError = e as Error;
    }

    // This currently throws "Bad control character in string literal in JSON"
    expect(
      jsonParseError,
      `JSON parse of model-echoed output failed: ${jsonParseError?.message}`
    ).toBeNull();
  });

  it("control chars in output are escaped to \\uXXXX form", async () => {
    const filePath = makeControlCharFile();
    const result = await callReadTool({ path: filePath });
    const text = getTextContent(result);

    // After the fix: lines containing control chars should show \uXXXX escapes
    expect(text).toMatch(/\\u0001/);  // SOH escaped
    expect(text).toMatch(/\\u0002/);  // STX escaped
    expect(text).toMatch(/\\u0007/);  // BEL escaped
    expect(text).toMatch(/\\u001f/);  // US escaped
  });

  it("grep output escapes control chars to \\uXXXX form", async () => {
    const filePath = makeControlCharFile();
    const result = await callGrepTool({ pattern: "line with", path: filePath, literal: true });
    const text = getTextContent(result);

    expect(text).toContain("\\u0001");
    expect(text).toContain("\\u0002");
    expect(text).toContain("\\u0007");
    expect(text).toContain("\\u001f");
  });

  it("read and grep anchors from escaped output still validate against the raw file", async () => {
    const filePath = makeControlCharFile();
    const readResult = await callReadTool({ path: filePath });
    const grepResult = await callGrepTool({ pattern: "line with", path: filePath, literal: true });

    const readText = getTextContent(readResult);
    const grepText = getTextContent(grepResult);

    // Extract anchor for line 2 from read output (format: "2:xx|display text")
    const readAnchor = readText.match(/^2:[0-9a-f]{3}\|/m)?.[0].replace(/\|$/, "");
    // Extract anchor for line 5 from grep output (format: "path:>>5:xx|display text")
    const grepAnchor = grepText.match(/>>5:([0-9a-f]{3})\|/m)?.[0].replace(/^>>/, "").replace(/\|$/, "");

    expect(readAnchor, "read output should contain a LINE:HASH anchor for line 2").toBeTruthy();
    expect(grepAnchor, "grep output should contain a LINE:HASH anchor for line 5").toBeTruthy();

    const { applyHashlineEdits } = await import("../src/hashline.js");
    const original = readFileSync(filePath, "utf-8");

    // If escapeControlChars had accidentally been applied before hashing,
    // these applyHashlineEdits calls would throw a hash-mismatch error.
    const readEdited = applyHashlineEdits(original, [
      { set_line: { anchor: readAnchor!, new_text: "// read-anchor-ok" } },
    ]);
    expect(readEdited.firstChangedLine).toBe(2);
    expect(readEdited.content).toContain("// read-anchor-ok");

    const grepEdited = applyHashlineEdits(original, [
      { set_line: { anchor: grepAnchor!, new_text: "// grep-anchor-ok" } },
    ]);
    expect(grepEdited.firstChangedLine).toBe(5);
    expect(grepEdited.content).toContain("// grep-anchor-ok");
  });
});
