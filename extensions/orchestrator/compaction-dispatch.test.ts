import { describe, it, expect } from "vitest";
import { computeVccMessageRange, buildVccDetails } from "./compaction-dispatch.js";

function msg(id: string) {
  return { id, type: "message", message: { role: "user", content: "x" } };
}

describe("computeVccMessageRange", () => {
  it("returns [firstMessageId, firstKeptEntryId] for a normal cut", () => {
    const entries = [msg("m1"), msg("m2"), msg("m3"), msg("m4")];
    expect(computeVccMessageRange(entries, "m3")).toEqual(["m1", "m3"]);
  });

  it("returns undefined when the first kept entry is the first message (nothing summarized)", () => {
    const entries = [msg("m1"), msg("m2")];
    expect(computeVccMessageRange(entries, "m1")).toBeUndefined();
  });

  it("returns undefined when there are no message entries", () => {
    expect(computeVccMessageRange([{ id: "c1", type: "compaction" }], "c1")).toBeUndefined();
  });

  it("spans first..last message for the compact-all sentinel (empty firstKeptEntryId)", () => {
    const entries = [msg("m1"), msg("m2"), msg("m3")];
    expect(computeVccMessageRange(entries, "")).toEqual(["m1", "m3"]);
  });
});

describe("buildVccDetails", () => {
  it("produces the pi-vcc metadata contract that vcc_recall expects", () => {
    const summary = "[Session Goal]\nDo the thing\n\n[Files And Changes]\n- a.ts";
    const details = buildVccDetails(summary, 12, true, 48000, ["m1", "m5"]);
    expect(details.compactor).toBe("pi-vcc");
    expect(details.version).toBe(1);
    expect(details.sections).toEqual(["Session Goal", "Files And Changes"]);
    expect(details.sourceMessageCount).toBe(12);
    expect(details.previousSummaryUsed).toBe(true);
    expect(details.messageRange).toEqual(["m1", "m5"]);
    expect(details.tokensBefore).toBe(48000);
    expect(typeof details.timestamp).toBe("string");
  });

  it("omits tokensBefore/compressionRatio when tokensBefore is 0", () => {
    const details = buildVccDetails("[X]\ny", 0, false, 0, undefined);
    expect(details.tokensBefore).toBeUndefined();
    expect(details.compressionRatio).toBeUndefined();
    expect(details.messageRange).toBeUndefined();
  });
});
