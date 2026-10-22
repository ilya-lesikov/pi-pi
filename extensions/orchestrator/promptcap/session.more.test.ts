import { describe, expect, it } from "vitest";
import { activeLineageEntryIds, clip, findToolCall, fullText, renderMessage, textOf, thinkingOf } from "./session.js";

describe("renderMessage", () => {
  it("summarises a tool call by its path, command, query or argument names", () => {
    const message: any = {
      role: "assistant",
      content: [
        { type: "toolCall", name: "read", arguments: { file_path: "/a.ts" } },
        { type: "toolCall", name: "bash", arguments: { command: "ls -la" } },
        { type: "toolCall", name: "grep", arguments: { query: "needle" } },
        { type: "toolCall", name: "edit", arguments: { a: 1, b: 2 } },
        { type: "toolCall", name: "noop" },
      ],
    };
    const rendered = renderMessage(message, 4);
    expect(rendered).toEqual({ index: 4, role: "assistant", summary: "read(path=/a.ts), bash(command=ls -la), grep(query=needle), edit(a, b), noop()\n", files: ["/a.ts"] });
  });

  it("marks errored tool results and labels bash executions", () => {
    expect(renderMessage({ role: "toolResult", toolName: "bash", isError: true, content: [{ type: "text", text: "boom" }] } as any, 0).summary).toBe("ERROR [bash] boom");
    expect(renderMessage({ role: "bashExecution", command: "make", output: "done" } as any, 1)).toEqual({ index: 1, role: "bash", summary: "$ make\ndone" });
    expect(renderMessage({ role: "bashExecution" } as any, 1).summary).toBe("$ \n");
  });

  it("clips a long bash execution and marks where a full one was cut", () => {
    const output = "o".repeat(5000);
    expect(renderMessage({ role: "bashExecution", command: "x", output } as any, 0).summary.length).toBe(300);
    expect(renderMessage({ role: "bashExecution", command: "x", output } as any, 0, true).summary).toContain("characters not shown");
  });

  it("puts clipped reasoning ahead of the reply", () => {
    const message: any = { role: "assistant", content: [{ type: "thinking", thinking: "hmm" }, { type: "text", text: "answer" }] };
    expect(renderMessage(message, 0).summary).toBe("[thinking] hmm\nanswer");
    expect(renderMessage(message, 0, true).summary).toBe("[thinking] hmm\nanswer");
  });

  it("tolerates an assistant message with string content", () => {
    expect(renderMessage({ role: "assistant", content: "plain" } as any, 0).summary).toBe("plain");
  });
});

describe("content helpers", () => {
  it("reads text and thinking from strings, arrays and nothing", () => {
    expect(textOf(undefined)).toBe("");
    expect(textOf("s" as any)).toBe("s");
    expect(thinkingOf("s" as any)).toBe("");
    expect(thinkingOf([{ type: "thinking" }] as any)).toBe("");
  });

  it("gives bash executions and plain messages their searchable text", () => {
    expect(fullText({ role: "bashExecution", command: "a" } as any)).toBe("a ");
    expect(fullText({ role: "user", content: [{ type: "text", text: "t" }] } as any)).toBe("t");
  });

  it("clips at a word boundary and never splits a surrogate pair", () => {
    expect(clip("aaaaa bbbb", 8)).toBe("aaaaa");
    expect(clip("aaaa bbbb", 7)).toBe("aaaa bb");
    expect(clip("ab😀cd", 3)).toBe("ab");
  });
});

describe("activeLineageEntryIds", () => {
  it("prefers the branch, falls back to all entries, and survives a broken manager", () => {
    expect([...activeLineageEntryIds({ getBranch: () => [{ id: "a" }, {}], getEntries: () => [{ id: "z" }] })]).toEqual(["a"]);
    expect([...activeLineageEntryIds({ getBranch: () => [], getEntries: () => [{ id: "z" }] })]).toEqual(["z"]);
    expect([...activeLineageEntryIds({ getEntries: () => { throw new Error("x"); } })]).toEqual([]);
    expect([...activeLineageEntryIds(undefined)]).toEqual([]);
  });
});

describe("findToolCall", () => {
  it("joins the call's arguments with its result, defaulting an image's mime type", () => {
    const entries = [
      null,
      { message: { role: "assistant", content: [{ type: "toolCall", id: "c1" }] } },
      { message: { role: "toolResult", toolCallId: "c1", content: [{ type: "text", text: "out" }, { type: "image", data: "IMG" }, { type: "image" }] } },
      { message: { role: "toolResult", toolCallId: 7 } },
    ];
    expect(findToolCall(entries, "c1")).toEqual({ args: {}, output: "out", images: [{ data: "IMG", mimeType: "image/png" }] });
  });

  it("returns an empty output for a result without content", () => {
    expect(findToolCall([{ message: { role: "toolResult", toolCallId: "c2" } }], "c2")).toEqual({ output: "" });
  });

  it("hands back the images of the user message an aged-out attachment notice names", () => {
    const entries = [
      { message: { role: "user", timestamp: 41, content: [{ type: "image", data: "OLD" }] } },
      { message: { role: "user", timestamp: 42, content: [{ type: "text", text: "look" }, { type: "image", data: "IMG", mimeType: "image/jpeg" }] } },
    ];
    expect(findToolCall(entries, "attached-42")).toEqual({ output: "look", images: [{ data: "IMG", mimeType: "image/jpeg" }] });
    expect(findToolCall(entries, "attached-7")).toBeUndefined();
  });

  it("hands back every image attached in the same millisecond, and nothing where none was attached", () => {
    const entries = [
      { message: { role: "user", timestamp: 42, content: [{ type: "text", text: "first" }, { type: "image", data: "ONE" }] } },
      { message: { role: "user", timestamp: 42, content: [{ type: "text", text: "plain" }] } },
      { message: { role: "user", timestamp: 42, content: [{ type: "text", text: "second" }, { type: "image", data: "TWO", mimeType: "image/jpeg" }] } },
      { message: { role: "user", timestamp: 43, content: [{ type: "text", text: "no picture" }] } },
    ];
    expect(findToolCall(entries, "attached-42")).toEqual({
      output: "first\nsecond",
      images: [{ data: "ONE", mimeType: "image/png" }, { data: "TWO", mimeType: "image/jpeg" }],
    });
    expect(findToolCall(entries, "attached-43")).toBeUndefined();
    expect(findToolCall(entries, "attached-42-2")).toBeUndefined();
  });
});
