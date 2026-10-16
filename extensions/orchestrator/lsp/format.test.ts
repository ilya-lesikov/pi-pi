import { describe, expect, it } from "vitest";
import {
  formatCallHierarchy,
  formatCodeActions,
  formatDiagnostics,
  formatDocumentSymbols,
  formatEditDiagnostics,
  formatHover,
  formatIncomingCalls,
  formatLocations,
  formatOutgoingCalls,
  formatWorkspaceSymbols,
  relativePath,
} from "./format.js";
import type { CallHierarchyItem, Diagnostic, DocumentSymbol, Location, Range, SymbolInformation } from "./types.js";

const ROOT = "/repo";
const range = (line: number, character: number, endLine = line, endCharacter = character + 1): Range => ({
  start: { line, character },
  end: { line: endLine, character: endCharacter },
});
const loc = (file: string, line: number, character = 0): Location => ({ uri: `file:///repo/${file}`, range: range(line, character) });
const diag = (line: number, message: string, extra: Partial<Diagnostic> = {}): Diagnostic => ({ range: range(line, 0), message, ...extra });
const item = (name: string, file: string, line: number): CallHierarchyItem => ({
  name,
  kind: 12,
  uri: `file:///repo/${file}`,
  range: range(line, 0),
  selectionRange: range(line, 4),
});

describe("relativePath", () => {
  it("relativizes inside the root with or without a trailing separator", () => {
    expect(relativePath("file:///repo/src/a.ts", "/repo")).toBe("src/a.ts");
    expect(relativePath("file:///repo/src/a.ts", "/repo/")).toBe("src/a.ts");
    expect(relativePath("file:///repo/my%20dir/a.ts", "/repo")).toBe("my dir/a.ts");
  });

  it("keeps the absolute path outside the root", () => {
    expect(relativePath("file:///repo2/a.ts", "/repo")).toBe("/repo2/a.ts");
    expect(relativePath("file:///usr/lib/x.d.ts", "/repo")).toBe("/usr/lib/x.d.ts");
  });

  it("handles Windows drive-letter case and backslashes", () => {
    expect(relativePath("file:///C:/repo/src/a.ts", "c:\\repo")).toBe("src\\a.ts");
    expect(relativePath("file:///C:/repo/src/a.ts", "C:\\repo\\")).toBe("src\\a.ts");
    expect(relativePath("file:///D:/other/a.ts", "c:\\repo")).toBe("D:\\other\\a.ts");
  });

  it("prints non-file URIs as-is", () => {
    expect(relativePath("jdt://contents/java.base/String.class", ROOT)).toBe("jdt://contents/java.base/String.class");
    expect(relativePath("untitled:Untitled-1", ROOT)).toBe("untitled:Untitled-1");
  });
});

describe("formatDiagnostics", () => {
  it("summarizes and groups", () => {
    const text = formatDiagnostics("src/foo.ts", [
      {
        source: "typescript",
        diagnostics: [
          diag(1, "Type string is not assignable to number", {
            range: range(1, 2, 1, 8),
            severity: 1,
            source: "ts",
            code: 2322,
            codeDescription: { href: "https://x/2322" },
          }),
        ],
      },
      { source: "eslint", diagnostics: [diag(3, "Unused", { range: range(3, 0, 4, 2), severity: 2, source: "eslint", code: "no-unused-vars" })] },
    ]);
    expect(text).toBe(
      [
        "Diagnostics for src/foo.ts: 1 error, 1 warning",
        "",
        "── typescript ──",
        "1. ERROR line 2:3-9 [ts](2322)",
        "   Type string is not assignable to number",
        "   Docs: https://x/2322",
        "",
        "── eslint ──",
        "1. WARN lines 4:1-5:3 [eslint](no-unused-vars)",
        "   Unused",
      ].join("\n"),
    );
  });

  it("reports clean files", () => {
    expect(formatDiagnostics("a.ts", [{ source: "ts", diagnostics: [] }])).toBe("a.ts: No diagnostics — all clean ✓");
  });

  it("caps at 100 across groups", () => {
    const many = Array.from({ length: 70 }, (_, i) => diag(i, `m${i}`, { severity: 3 }));
    const text = formatDiagnostics("a.ts", [
      { source: "a", diagnostics: many },
      { source: "b", diagnostics: many },
    ]);
    expect(text).toContain("Diagnostics for a.ts: 140 info/hint");
    expect(text.match(/^\d+\. INFO/gm)).toHaveLength(100);
    expect(text.endsWith("… 40 more")).toBe(true);
  });
});

describe("formatEditDiagnostics", () => {
  it("keeps errors and warnings, errors first then by line, deduped", () => {
    const text = formatEditDiagnostics("src/a.ts", [
      diag(9, "warn here", { severity: 2, source: "eslint" }),
      diag(2, "Type 'string' is not\n  assignable to type 'number'.", { range: range(2, 4), severity: 1, source: "ts", code: 2322 }),
      diag(2, "Type 'string' is not\n  assignable to type 'number'.", { range: range(2, 4), severity: 1, source: "ts", code: 2322 }),
      diag(5, "no severity"),
      diag(1, "info", { severity: 3 }),
      diag(1, "hint", { severity: 4 }),
    ]);
    expect(text).toBe(
      [
        '<diagnostics file="src/a.ts">',
        "ERROR 3:5 [ts 2322] Type 'string' is not assignable to type 'number'.",
        "ERROR 6:1 no severity",
        "WARN 10:1 [eslint] warn here",
        "</diagnostics>",
      ].join("\n"),
    );
  });

  it("caps at the limit", () => {
    const text = formatEditDiagnostics("a.ts", Array.from({ length: 25 }, (_, i) => diag(i, `e${i}`, { severity: 1, code: 7 })))!;
    expect(text.split("\n").filter((l) => l.startsWith("ERROR"))).toHaveLength(20);
    expect(text).toContain("ERROR 20:1 [7] e19\n… 5 more\n</diagnostics>");
    expect(formatEditDiagnostics("a.ts", [diag(0, "a", { severity: 1 }), diag(1, "b", { severity: 1 })], 1)).toContain("… 1 more");
  });

  it("returns null when nothing remains", () => {
    expect(formatEditDiagnostics("a.ts", [])).toBeNull();
    expect(formatEditDiagnostics("a.ts", [diag(0, "i", { severity: 3 }), diag(0, "h", { severity: 4 })])).toBeNull();
  });
});

describe("formatHover", () => {
  it("handles MarkupContent, MarkedString and arrays", () => {
    expect(formatHover({ contents: { kind: "markdown", value: "  **x**\n" } }, "a.ts", 0, 4)).toBe("Hover at a.ts:1:5:\n\n**x**");
    expect(formatHover({ contents: "plain" }, "a.ts", 1, 0)).toBe("Hover at a.ts:2:1:\n\nplain");
    expect(formatHover({ contents: { language: "ts", value: "let x: number" } }, "a.ts", 0, 0)).toBe(
      "Hover at a.ts:1:1:\n\n```ts\nlet x: number\n```",
    );
    expect(formatHover({ contents: ["doc", { language: "ts", value: "f()" }] }, "a.ts", 0, 0)).toBe("Hover at a.ts:1:1:\n\ndoc\n\n```ts\nf()\n```");
  });

  it("reports missing or empty hover", () => {
    expect(formatHover(null, "a.ts", 2, 3)).toBe("No hover information at a.ts:3:4");
    expect(formatHover({ contents: { kind: "plaintext", value: "  \n" } }, "a.ts", 2, 3)).toBe("No hover information at a.ts:3:4");
    expect(formatHover({ contents: [] }, "a.ts", 2, 3)).toBe("No hover information at a.ts:3:4");
  });
});

describe("formatLocations", () => {
  it("accepts a single Location, relative and absolute", () => {
    expect(formatLocations(loc("src/b.ts", 4, 2), "Definition", "src/a.ts", 0, 0, ROOT)).toBe(
      "Definition for symbol at src/a.ts:1:1 (1 result):\n\n1. src/b.ts:5:3",
    );
    expect(formatLocations([{ uri: "file:///lib/x.d.ts", range: range(0, 0) }], "Definition", "a.ts", 0, 0, ROOT)).toContain("1. /lib/x.d.ts:1:1");
  });

  it("uses targetSelectionRange for LocationLink", () => {
    const text = formatLocations(
      [{ targetUri: "file:///repo/src/b.ts", targetRange: range(1, 0, 5, 0), targetSelectionRange: range(2, 9) }],
      "Definition",
      "a.ts",
      0,
      0,
      ROOT,
    );
    expect(text).toContain("1. src/b.ts:3:10");
  });

  it("sorts by path, line, column and drops duplicates", () => {
    const text = formatLocations(
      [loc("b.ts", 3, 1), loc("a.ts", 10), loc("b.ts", 3, 0), loc("a.ts", 2), loc("a.ts", 10)],
      "References",
      "a.ts",
      0,
      0,
      ROOT,
    );
    expect(text).toBe("References for symbol at a.ts:1:1 (4 results):\n\n1. a.ts:3:1\n2. a.ts:11:1\n3. b.ts:4:1\n4. b.ts:4:2");
  });

  it("caps at 100", () => {
    const text = formatLocations(Array.from({ length: 150 }, (_, i) => loc("a.ts", i)), "References", "a.ts", 0, 0, ROOT);
    expect(text).toContain("(150 results)");
    expect(text).toContain("100. a.ts:100:1");
    expect(text).not.toContain("101.");
    expect(text.endsWith("(showing 100 of 150)")).toBe(true);
  });

  it("reports nothing found", () => {
    expect(formatLocations(null, "Definition", "a.ts", 1, 2, ROOT)).toBe("No Definition found for symbol at a.ts:2:3");
    expect(formatLocations([], "Implementation", "a.ts", 1, 2, ROOT)).toBe("No Implementation found for symbol at a.ts:2:3");
  });
});

describe("formatDocumentSymbols", () => {
  it("renders a DocumentSymbol tree", () => {
    const symbols: DocumentSymbol[] = [
      {
        name: "Foo",
        kind: 5,
        range: range(0, 0, 10, 1),
        selectionRange: range(0, 6),
        children: [{ name: "bar", detail: "(): void", kind: 6, range: range(1, 2), selectionRange: range(1, 2) }],
      },
      { name: "weird", kind: 99, range: range(12, 0), selectionRange: range(12, 0) },
    ];
    expect(formatDocumentSymbols(symbols, "a.ts", ROOT)).toBe(
      "Symbols in a.ts (2 top-level):\n\nFoo (class) line 1:7\n  bar (method) line 2:3 — (): void\nweird (kind(99)) line 13:1",
    );
  });

  it("renders flat SymbolInformation", () => {
    const symbols: SymbolInformation[] = [{ name: "x", kind: 13, location: loc("a.ts", 2, 4), containerName: "Foo" }];
    expect(formatDocumentSymbols(symbols, "a.ts", ROOT)).toBe("Symbols in a.ts (1):\n\n1. x (variable) a.ts:3:5 in Foo");
  });

  it("caps the tree at 300 lines", () => {
    const symbols: DocumentSymbol[] = Array.from({ length: 200 }, (_, i) => ({
      name: `s${i}`,
      kind: 12,
      range: range(i, 0),
      selectionRange: range(i, 0),
      children: [{ name: `c${i}`, kind: 13, range: range(i, 1), selectionRange: range(i, 1) }],
    }));
    const text = formatDocumentSymbols(symbols, "a.ts", ROOT);
    expect(text.split("\n\n")[1].split("\n")).toHaveLength(300);
    expect(text.endsWith("(showing 300 of 400)")).toBe(true);
  });

  it("reports no symbols", () => {
    expect(formatDocumentSymbols(null, "a.ts", ROOT)).toBe("No symbols found in a.ts");
    expect(formatDocumentSymbols([], "a.ts", ROOT)).toBe("No symbols found in a.ts");
  });
});

describe("formatWorkspaceSymbols", () => {
  it("prints locations and uri-only symbols", () => {
    const text = formatWorkspaceSymbols(
      [
        { name: "Foo", kind: 5, location: loc("src/foo.ts", 0, 13) },
        { name: "Bar", kind: 11, location: { uri: "file:///repo/src/bar.ts" }, containerName: "ns" },
      ],
      "o",
      ROOT,
    );
    expect(text).toBe('Workspace symbols matching "o" (2):\n\n1. Foo (class) src/foo.ts:1:14\n2. Bar (interface) src/bar.ts in ns');
  });

  it("caps at 50", () => {
    const symbols = Array.from({ length: 60 }, (_, i): SymbolInformation => ({ name: `s${i}`, kind: 12, location: loc("a.ts", i) }));
    const text = formatWorkspaceSymbols(symbols, "s", ROOT);
    expect(text).toContain("50. s49");
    expect(text).not.toContain("51.");
    expect(text.endsWith("(showing 50 of 60)")).toBe(true);
  });

  it("reports no matches", () => {
    expect(formatWorkspaceSymbols([], "zz", ROOT)).toBe('No workspace symbols matching "zz"');
  });
});

describe("call hierarchy", () => {
  const foo = { ...item("foo", "src/a.ts", 4), detail: "(): void" };

  it("formats prepared items", () => {
    expect(formatCallHierarchy([foo], "src/a.ts", 4, 9, ROOT)).toBe("Call hierarchy at src/a.ts:5:10:\n\n1. foo (function) src/a.ts:5 — (): void");
    expect(formatCallHierarchy(null, "src/a.ts", 4, 9, ROOT)).toBe("No call hierarchy item at src/a.ts:5:10");
  });

  it("formats incoming and outgoing calls", () => {
    expect(formatIncomingCalls([{ from: item("main", "src/main.ts", 0), fromRanges: [] }], foo, ROOT)).toBe(
      "Incoming calls to foo (1):\n\n1. main (function) src/main.ts:1",
    );
    expect(formatOutgoingCalls([{ to: { ...item("log", "x", 2), uri: "file:///lib/log.ts" }, fromRanges: [] }], foo, ROOT)).toBe(
      "Outgoing calls from foo (1):\n\n1. log (function) /lib/log.ts:3",
    );
    expect(formatIncomingCalls([], foo, ROOT)).toBe("No incoming calls to foo");
    expect(formatOutgoingCalls(null, foo, ROOT)).toBe("No outgoing calls from foo");
  });
});

describe("formatCodeActions", () => {
  it("formats kinds, preferred, changes, documentChanges and commands", () => {
    const edit = { range: range(0, 0), newText: "" };
    const text = formatCodeActions(
      [
        { title: "Fix", kind: "quickfix", isPreferred: true, edit: { changes: { "file:///repo/a.ts": [edit, edit] } } },
        {
          title: "Rename",
          kind: "refactor",
          edit: { documentChanges: [{ textDocument: { uri: "file:///repo/a.ts" }, edits: [edit] }, { textDocument: { uri: "file:///repo/b.ts" }, edits: [edit] }] },
        },
        { title: "Organize", kind: "source", command: { title: "Organize imports", command: "ts.organize" } },
        { title: "Run thing", command: "x.run" },
      ],
      "a.ts",
      3,
    );
    expect(text).toBe(
      [
        "Code actions at a.ts:4 (4 available):",
        "",
        "1. Fix [quickfix] ★ preferred",
        "   Changes: 2 edits across 1 file",
        "",
        "2. Rename [refactor]",
        "   Changes: 2 edits across 2 files",
        "",
        "3. Organize [source]",
        "   command: Organize imports",
        "",
        "4. Run thing",
        "   command: Run thing",
      ].join("\n"),
    );
  });

  it("caps at 30", () => {
    const text = formatCodeActions(Array.from({ length: 40 }, (_, i) => ({ title: `a${i}` })), "a.ts", 0);
    expect(text).toContain("30. a29");
    expect(text).not.toContain("31.");
    expect(text.endsWith("(showing 30 of 40)")).toBe(true);
  });

  it("reports none", () => {
    expect(formatCodeActions(null, "a.ts", 0)).toBe("No code actions available at a.ts:1");
  });
});
