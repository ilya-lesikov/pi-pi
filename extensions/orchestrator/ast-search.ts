import { execFile } from "child_process";
import { existsSync } from "fs";
import { resolve } from "path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

function isSgAvailable(): boolean {
  try {
    const { execFileSync } = require("child_process");
    execFileSync("sg", ["--version"], { encoding: "utf-8", stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function ok(text: string) {
  return { content: [{ type: "text" as const, text }], details: {} };
}

function fail(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true as const, details: {} };
}

export function registerAstSearchTool(pi: ExtensionAPI, cwd: string): boolean {
  if (!isSgAvailable()) return false;

  pi.registerTool({
    name: "ast_search",
    label: "ast-grep",
    description:
      "Search code using AST-aware structural patterns. Uses ast-grep (sg). " +
      "Patterns use meta-variables: $NAME matches a single node, $$$ matches multiple nodes. " +
      "Examples: 'if err != nil { $$$ }', 'func $NAME($$$) { $$$ }', '$X.($TYPE)'",
    parameters: Type.Object({
      pattern: Type.String({ description: "AST pattern to search for" }),
      lang: Type.Optional(Type.String({ description: "Language hint (e.g. 'go', 'typescript', 'python')" })),
      path: Type.Optional(Type.String({ description: "Directory or file to search (default: project root)" })),
    }),
    async execute(_toolCallId: string, params: any) {
      const searchPath = resolve(cwd, params.path ?? ".");
      if (!existsSync(searchPath)) {
        return fail(`Path '${params.path}' does not exist`);
      }

      const args = ["run", "--json", "-p", params.pattern];
      if (params.lang) args.push("-l", params.lang);
      args.push(searchPath);

      try {
        const stdout = await new Promise<string>((res, rej) => {
          execFile("sg", args, { timeout: 30000, encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 }, (err, out, stderr) => {
            if (err && !out) return rej(new Error(stderr?.trim() || err.message));
            res(out);
          });
        });

        const results = JSON.parse(stdout || "[]");
        if (!Array.isArray(results) || results.length === 0) {
          return ok("No matches found.");
        }

        const lines: string[] = [];
        for (const match of results) {
          const file = match.file ?? "?";
          const startLine = match.range?.start?.line ?? match.start?.line ?? "?";
          const text = match.text ?? match.matchedCode ?? "";
          lines.push(`${file}:${startLine}: ${text.trim()}`);
        }

        return ok(`${results.length} match(es):\n\n${lines.join("\n")}`);
      } catch (e: any) {
        return fail(`ast_search error: ${e.message}`);
      }
    },
  });

  return true;
}
