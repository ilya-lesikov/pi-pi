import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encodeCwd, streamToOutputFile, writeInitialEntry } from "../src/output-file.js";

describe("encodeCwd", () => {
  it("encodes a POSIX absolute path by stripping the leading slash and replacing separators", () => {
    expect(encodeCwd("/home/user/project")).toBe("home-user-project");
  });

  it("handles a POSIX root path", () => {
    expect(encodeCwd("/")).toBe("");
  });

  it("encodes a Windows drive-letter path by stripping the drive prefix", () => {
    expect(encodeCwd("C:\\Users\\foo\\project")).toBe("Users-foo-project");
  });

  it("handles lowercase Windows drives", () => {
    expect(encodeCwd("c:\\foo")).toBe("foo");
  });

  it("handles a Windows path written with forward slashes", () => {
    expect(encodeCwd("C:/Users/foo/project")).toBe("Users-foo-project");
  });

  it("preserves server and share for UNC paths", () => {
    expect(encodeCwd("\\\\server\\share\\project")).toBe("server-share-project");
  });

  it("handles mixed separators", () => {
    expect(encodeCwd("/home\\user/project")).toBe("home-user-project");
  });

  it("collapses runs of leading dashes after separator replacement", () => {
    expect(encodeCwd("///foo")).toBe("foo");
  });

  it("returns an empty string for an empty cwd", () => {
    expect(encodeCwd("")).toBe("");
  });

  it("leaves a relative-looking path with no leading separator alone", () => {
    expect(encodeCwd("foo/bar")).toBe("foo-bar");
  });
});

/**
 * Minimal AgentSession fake. streamToOutputFile only reads `session.messages`
 * and calls `session.subscribe(cb)`, so we provide just those — plus test-only
 * helpers to mutate state and fire events deterministically.
 */
function makeFakeSession(initialMessages: unknown[] = []) {
  const messages: unknown[] = [...initialMessages];
  let cb: ((event: unknown) => void) | null = null;
  return {
    get messages() {
      return messages;
    },
    subscribe(fn: (event: unknown) => void) {
      cb = fn;
      return () => {
        cb = null;
      };
    },
    push(...msgs: unknown[]) {
      messages.push(...msgs);
    },
    fire(event: unknown) {
      cb?.(event);
    },
    isSubscribed() {
      return cb !== null;
    },
  };
}

describe("streamToOutputFile", () => {
  let tmp: string;
  let outPath: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "stream-out-test-"));
    outPath = join(tmp, "agent.output");
    writeInitialEntry(outPath, "agent-1", "do the thing", "/work");
  });

  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  function readEntries(): Array<Record<string, unknown>> {
    return readFileSync(outPath, "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
  }

  it("writes nothing past the initial entry until turn_end fires", () => {
    const session = makeFakeSession([{ role: "user", content: "do the thing" }]);
    streamToOutputFile(session as never, outPath, "agent-1", "/work");

    session.push({ role: "assistant", content: [{ type: "text", text: "ok" }] });
    expect(readEntries()).toHaveLength(1); // only the initial entry

    session.fire({ type: "turn_end" });
    expect(readEntries()).toHaveLength(2);
  });

  it("tags assistant, user, and tool messages with the correct type field", () => {
    const session = makeFakeSession([{ role: "user", content: "go" }]);
    streamToOutputFile(session as never, outPath, "agent-1", "/work");

    session.push(
      { role: "assistant", content: [{ type: "text", text: "thinking" }] },
      { role: "user", content: "follow-up" },
      { role: "tool", content: [{ type: "tool_result", content: "x" }] },
    );
    session.fire({ type: "turn_end" });

    const entries = readEntries();
    expect(entries.map((e) => e.type)).toEqual(["user", "assistant", "user", "toolResult"]);
    expect(entries.every((e) => e.agentId === "agent-1" && e.isSidechain === true)).toBe(true);
    expect(entries.every((e) => e.cwd === "/work")).toBe(true);
  });

  it("never re-emits messages already flushed on a previous turn_end", () => {
    const session = makeFakeSession([{ role: "user", content: "go" }]);
    streamToOutputFile(session as never, outPath, "agent-1", "/work");

    session.push({ role: "assistant", content: [{ type: "text", text: "one" }] });
    session.fire({ type: "turn_end" });

    session.push({ role: "assistant", content: [{ type: "text", text: "two" }] });
    session.fire({ type: "turn_end" });

    // Fire a redundant turn_end with no new messages — must not duplicate
    session.fire({ type: "turn_end" });

    expect(readEntries()).toHaveLength(3);
  });

  it("ignores session events other than turn_end", () => {
    const session = makeFakeSession([{ role: "user", content: "go" }]);
    streamToOutputFile(session as never, outPath, "agent-1", "/work");

    session.push({ role: "assistant", content: [{ type: "text", text: "x" }] });
    session.fire({ type: "message_start" });
    session.fire({ type: "tool_call" });
    session.fire({ type: "message_end" });

    expect(readEntries()).toHaveLength(1);
  });

  it("cleanup() does a final flush and detaches the subscription", () => {
    const session = makeFakeSession([{ role: "user", content: "go" }]);
    const cleanup = streamToOutputFile(session as never, outPath, "agent-1", "/work");

    // Trailing message arrives with no turn_end before shutdown
    session.push({ role: "assistant", content: [{ type: "text", text: "tail" }] });
    expect(readEntries()).toHaveLength(1);

    cleanup();
    expect(readEntries()).toHaveLength(2);
    expect(session.isSubscribed()).toBe(false);

    // Post-cleanup messages must not be written, even if events would otherwise fire
    session.push({ role: "assistant", content: [{ type: "text", text: "ghost" }] });
    session.fire({ type: "turn_end" });
    expect(readEntries()).toHaveLength(2);
  });
});
