import { describe, expect, it, vi } from "vitest";
import { getDefaultConfig, normalizeConfigDurations } from "./config.js";
import { Orchestrator } from "./orchestrator.js";

const askUser = vi.fn();
vi.mock("../../3p/pi-ask-user/index.js", () => ({
  askUser: (...args: any[]) => askUser(...args),
  isCancel: (result: any) => !!result?.__cancel,
}));

describe("/pp session control panel", () => {
  it("contains controls but no task or phase launcher", async () => {
    askUser.mockResolvedValueOnce({ kind: "selection", selections: ["Close"] });
    const orchestrator = new Orchestrator({ appendEntry: vi.fn() } as any);
    orchestrator.cwd = "/tmp/project";
    orchestrator.config = normalizeConfigDurations(getDefaultConfig());
    const { showPpMenu } = await import("./pp-menu.js");
    await showPpMenu(orchestrator, { model: null, sessionManager: {}, ui: {} });
    const options = askUser.mock.calls[0][1].options.map((option: any) => option.title);
    expect(options).toEqual(["Status", "Workers", "Skills", "Memory", "Agents", "Provider settings", "Close"]);
    expect(options).not.toContain("Task");
    expect(options).not.toContain("Quick");
    expect(options).not.toContain("Implement");
    expect(options).not.toContain("Next");
  });
});
