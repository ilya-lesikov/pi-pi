import { describe, it, expect } from "vitest";
import { registerReadTool } from "../src/read.js";
import { registerGrepTool } from "../src/grep.js";
import { registerSgTool } from "../src/sg.js";
import { registerEditTool } from "../src/edit.js";
import { registerLsTool } from "../src/ls.js";
import { registerFindTool } from "../src/find.js";
import { HASHLINE_TOOL_PTC_POLICY, getHashlineToolPtcPolicy } from "../src/ptc-tool-policy.js";
function captureTools() {
  const tools: Record<string, any> = {};
  const pi = {
    registerTool(def: any) {
      tools[def.name] = def;
    },
  };
  registerReadTool(pi as any);
  registerGrepTool(pi as any);
  registerSgTool(pi as any);
  registerEditTool(pi as any);
  registerLsTool(pi as any);
  registerFindTool(pi as any);
  return tools;
}
describe("hashline tool ptc policy contract", () => {
  it("mirrors the inline runtime ptc metadata for all exported hashline tools", () => {
    const tools = captureTools();
    expect(getHashlineToolPtcPolicy()).toBe(HASHLINE_TOOL_PTC_POLICY);
    expect(HASHLINE_TOOL_PTC_POLICY).toEqual({
      version: 1,
      tools: {
        read: {
          toolName: "read",
          helperName: "read",
          overridesBuiltin: true,
          mutability: "read-only",
          defaultExposure: "safe-by-default",
        },
        grep: {
          toolName: "grep",
          helperName: "grep",
          overridesBuiltin: true,
          mutability: "read-only",
          defaultExposure: "safe-by-default",
        },
        ast_search: {
          toolName: "ast_search",
          helperName: "ast_search",
          overridesBuiltin: false,
          mutability: "read-only",
          defaultExposure: "opt-in",
        },
        edit: {
          toolName: "edit",
          helperName: "edit",
          overridesBuiltin: true,
          mutability: "mutating",
          defaultExposure: "not-safe-by-default",
        },
        ls: {
          toolName: "ls",
          helperName: "ls",
          overridesBuiltin: true,
          mutability: "read-only",
          defaultExposure: "safe-by-default",
        },
        find: {
          toolName: "find",
          helperName: "find",
          overridesBuiltin: true,
          mutability: "read-only",
          defaultExposure: "safe-by-default",
        },
      },
    });
    expect(HASHLINE_TOOL_PTC_POLICY.tools.read.helperName).toBe(tools.read.ptc.pythonName);
    expect(HASHLINE_TOOL_PTC_POLICY.tools.grep.helperName).toBe(tools.grep.ptc.pythonName);
    expect(HASHLINE_TOOL_PTC_POLICY.tools.ast_search.helperName).toBe(tools.ast_search.ptc.pythonName);
    expect(HASHLINE_TOOL_PTC_POLICY.tools.edit.helperName).toBe(tools.edit.ptc.pythonName);
    expect(HASHLINE_TOOL_PTC_POLICY.tools.ls.helperName).toBe(tools.ls.ptc.pythonName);
    expect(HASHLINE_TOOL_PTC_POLICY.tools.find.helperName).toBe(tools.find.ptc.pythonName);
    expect(HASHLINE_TOOL_PTC_POLICY.tools.read.mutability).toBe(tools.read.ptc.policy);
    expect(HASHLINE_TOOL_PTC_POLICY.tools.grep.mutability).toBe(tools.grep.ptc.policy);
    expect(HASHLINE_TOOL_PTC_POLICY.tools.ast_search.mutability).toBe(tools.ast_search.ptc.policy);
    expect(HASHLINE_TOOL_PTC_POLICY.tools.edit.mutability).toBe(tools.edit.ptc.policy);
    expect(HASHLINE_TOOL_PTC_POLICY.tools.ls.mutability).toBe(tools.ls.ptc.policy);
    expect(HASHLINE_TOOL_PTC_POLICY.tools.find.mutability).toBe(tools.find.ptc.policy);
    expect(HASHLINE_TOOL_PTC_POLICY.tools.read.defaultExposure).toBe(tools.read.ptc.defaultExposure);
    expect(HASHLINE_TOOL_PTC_POLICY.tools.grep.defaultExposure).toBe(tools.grep.ptc.defaultExposure);
    expect(HASHLINE_TOOL_PTC_POLICY.tools.ast_search.defaultExposure).toBe(tools.ast_search.ptc.defaultExposure);
    expect(HASHLINE_TOOL_PTC_POLICY.tools.edit.defaultExposure).toBe(tools.edit.ptc.defaultExposure);
    expect(HASHLINE_TOOL_PTC_POLICY.tools.ls.defaultExposure).toBe(tools.ls.ptc.defaultExposure);
    expect(HASHLINE_TOOL_PTC_POLICY.tools.find.defaultExposure).toBe(tools.find.ptc.defaultExposure);
  });
});