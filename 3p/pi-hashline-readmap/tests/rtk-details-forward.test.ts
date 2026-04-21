import { describe, it, expect } from "vitest";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

function makeEvent(toolCallId: string, command: string, text: string, details?: unknown) {
  return {
    type: "tool_result" as const,
    toolName: "bash",
    toolCallId,
    input: { command },
    content: [{ type: "text" as const, text }],
    isError: false,
    details,
  };
}

describe("index.ts forwards info to details.compressionInfo", () => {
  it("includes compressionInfo on bash tool_result details", async () => {
    const modUrl = pathToFileURL(resolve(root, "index.ts")).href + "?t=details-" + Date.now();
    const handlers: Record<string, Function> = {};
    const mockPi = {
      registerTool() {},
      on(event: string, handler: Function) {
        handlers[event] = handler;
      },
      events: { emit() {}, on() {} },
    };
    const mod = await import(modUrl);
    mod.default(mockPi as any);

    const result = await handlers["tool_result"](
      makeEvent("t-fwd", "echo hi", "\x1b[32mhi\x1b[0m\n", { existing: "keep" }),
    );

    expect(result).toBeDefined();
    expect(result.details).toBeDefined();
    expect(result.details.existing).toBe("keep");
    expect(result.details.compressionInfo).toBeDefined();
    expect(result.details.compressionInfo.technique).toBe("none");
    expect(typeof result.details.compressionInfo.originalBytes).toBe("number");
    expect(typeof result.details.compressionInfo.outputBytes).toBe("number");
    expect(typeof result.details.compressionInfo.compressionRatio).toBe("number");
  });

  it("serializes compressionInfo via JSON.stringify without throwing", async () => {
    const modUrl = pathToFileURL(resolve(root, "index.ts")).href + "?t=json-" + Date.now();
    const handlers: Record<string, Function> = {};
    const mockPi = {
      registerTool() {},
      on(event: string, handler: Function) {
        handlers[event] = handler;
      },
      events: { emit() {}, on() {} },
    };
    const mod = await import(modUrl);
    mod.default(mockPi as any);

    const result = await handlers["tool_result"](makeEvent("t-json", "echo hi", "hi\n"));
    expect(() => JSON.stringify(result.details.compressionInfo)).not.toThrow();
  });
});
