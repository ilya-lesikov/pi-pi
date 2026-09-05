import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PP_ACP_STATE_TYPE,
  buildAcpState,
  isAcpMode,
  publishAcpState,
  resetAcpStateCache,
} from "./acp.js";
import { askUser, isCancel } from "../../3p/pi-ask-user/index.js";

const SUBAGENTS_KEY = Symbol.for("pi-subagents:manager");

function setSubagents(records: unknown[] | undefined): void {
  if (records === undefined) {
    delete (globalThis as any)[SUBAGENTS_KEY];
    return;
  }
  (globalThis as any)[SUBAGENTS_KEY] = { listAgents: () => records };
}

function makeOrchestrator(overrides: Record<string, unknown> = {}): any {
  return {
    active: null,
    configError: null,
    duplicateExtensionError: false,
    interactivePromptOpen: false,
    pi: { appendEntry: vi.fn() },
    ...overrides,
  };
}

function makeActive(phase: string, type = "implement", mode?: string): any {
  return { dir: "/tmp/t", type, state: { phase, step: "llm_work", mode } };
}

function phaseList(
  state: { phases?: Array<{ id: string; status: string; detail?: string }> },
): Array<[string, string]> {
  return (state.phases ?? []).map((p) => [p.id, p.status]);
}

beforeEach(() => {
  delete process.env.PI_ACP;
  setSubagents(undefined);
  resetAcpStateCache();
});

afterEach(() => {
  delete process.env.PI_ACP;
  setSubagents(undefined);
  resetAcpStateCache();
});

describe("isAcpMode", () => {
  it("is false when PI_ACP is unset", () => {
    expect(isAcpMode()).toBe(false);
  });

  it("is true only for the exact marker value", () => {
    process.env.PI_ACP = "1";
    expect(isAcpMode()).toBe(true);
    for (const value of ["0", "true", "", "01", "yes"]) {
      process.env.PI_ACP = value;
      expect(isAcpMode()).toBe(false);
    }
  });
});

describe("buildAcpState", () => {
  it("reports idle with no subagents when no task is active", () => {
    expect(buildAcpState(makeOrchestrator())).toEqual({
      status: "idle",
      subagents: [],
    });
  });

  it("omits phase/mode when idle so the payload stays narrow", () => {
    const state = buildAcpState(makeOrchestrator());
    expect(state).not.toHaveProperty("phase");
    expect(state).not.toHaveProperty("mode");
  });

  it("reports running with phase and mode for an active task", () => {
    const orchestrator = makeOrchestrator({
      active: makeActive("implement", "implement", "autonomous"),
    });
    expect(buildAcpState(orchestrator)).toEqual({
      phase: "implement",
      phases: [
        { id: "brainstorm", label: "Brainstorm", status: "completed" },
        { id: "plan", label: "Plan", status: "completed" },
        { id: "implement", label: "Implement", status: "in_progress" },
      ],
      mode: "autonomous",
      status: "running",
      subagents: [],
    });
  });

  it("omits mode for quick tasks, matching the footer indicator", () => {
    const orchestrator = makeOrchestrator({
      active: makeActive("quick", "quick"),
    });
    expect(buildAcpState(orchestrator)).toEqual({
      phase: "quick",
      phases: [{ id: "quick", label: "Quick", status: "in_progress" }],
      status: "running",
      subagents: [],
    });
  });

  it("reports waiting while an interactive prompt is open", () => {
    const orchestrator = makeOrchestrator({
      active: makeActive("plan"),
      interactivePromptOpen: true,
    });
    expect(buildAcpState(orchestrator).status).toBe("waiting");
  });

  it("reports waiting for a taskless /pp menu rather than idle", () => {
    const orchestrator = makeOrchestrator({ interactivePromptOpen: true });
    expect(buildAcpState(orchestrator)).toEqual({
      status: "waiting",
      subagents: [],
    });
  });

  it("reports completed for the done phase", () => {
    const orchestrator = makeOrchestrator({ active: makeActive("done") });
    expect(buildAcpState(orchestrator).status).toBe("completed");
  });

  it("reports failed on a config error, even with no active task", () => {
    expect(
      buildAcpState(makeOrchestrator({ configError: "bad json" })).status,
    ).toBe("failed");
  });

  it("reports failed on a duplicate-extension error", () => {
    expect(
      buildAcpState(makeOrchestrator({ duplicateExtensionError: true })).status,
    ).toBe("failed");
  });

  it("omits the phase list when there is no active task", () => {
    expect(buildAcpState(makeOrchestrator())).not.toHaveProperty("phases");
    expect(
      buildAcpState(makeOrchestrator({ configError: "bad json" })),
    ).not.toHaveProperty("phases");
  });
});

describe("buildAcpState phase list", () => {
  it("orders an implement task's phases and excludes done", () => {
    const state = buildAcpState(
      makeOrchestrator({ active: makeActive("brainstorm") }),
    );
    expect(phaseList(state)).toEqual([
      ["brainstorm", "in_progress"],
      ["plan", "pending"],
      ["implement", "pending"],
    ]);
  });

  it("orders a review task's phases, which start at review", () => {
    const state = buildAcpState(
      makeOrchestrator({ active: makeActive("plan", "review") }),
    );
    expect(phaseList(state)).toEqual([
      ["review", "completed"],
      ["plan", "in_progress"],
      ["implement", "pending"],
    ]);
  });

  it("gives a quick task its single phase", () => {
    const state = buildAcpState(
      makeOrchestrator({ active: makeActive("quick", "quick") }),
    );
    expect(phaseList(state)).toEqual([["quick", "in_progress"]]);
  });

  it("marks every phase completed once the task reaches done", () => {
    const state = buildAcpState(
      makeOrchestrator({ active: makeActive("done") }),
    );
    expect(phaseList(state)).toEqual([
      ["brainstorm", "completed"],
      ["plan", "completed"],
      ["implement", "completed"],
    ]);
    expect(state.status).toBe("completed");
  });

  it("reports an unknown phase as no progress rather than guessing", () => {
    const state = buildAcpState(
      makeOrchestrator({ active: makeActive("nonsense") }),
    );
    expect(phaseList(state)).toEqual([
      ["brainstorm", "pending"],
      ["plan", "pending"],
      ["implement", "pending"],
    ]);
  });

  it("details the current phase's step and review pass", () => {
    const active = makeActive("plan");
    active.state.step = "await_reviewers";
    active.state.reviewCycle = { kind: "auto", step: "await_reviewers", pass: 2 };
    const state = buildAcpState(makeOrchestrator({ active }));
    expect(state.phases?.[1]).toEqual({
      id: "plan",
      label: "Plan",
      status: "in_progress",
      detail: "review pass 2 · awaiting reviewers",
    });
  });

  it("carries detail only on the current phase", () => {
    const active = makeActive("plan");
    active.state.step = "synthesize";
    const state = buildAcpState(makeOrchestrator({ active }));
    expect(state.phases?.filter((p) => p.detail)).toEqual([
      {
        id: "plan",
        label: "Plan",
        status: "in_progress",
        detail: "synthesizing plans",
      },
    ]);
  });

  it("omits detail for steps that carry no information", () => {
    const active = makeActive("implement");
    active.state.step = "llm_work";
    expect(buildAcpState(makeOrchestrator({ active })).phases?.[2]).toEqual({
      id: "implement",
      label: "Implement",
      status: "in_progress",
    });
  });

  it("drops an unrecognised step instead of leaking it verbatim", () => {
    const active = makeActive("implement");
    active.state.step = "some_internal_step";
    expect(
      buildAcpState(makeOrchestrator({ active })).phases?.[2],
    ).not.toHaveProperty("detail");
  });

  it("omits a zeroed review pass", () => {
    const active = makeActive("implement");
    active.state.step = "apply_feedback";
    active.state.reviewCycle = {
      kind: "auto",
      step: "apply_feedback",
      pass: 0,
    };
    expect(buildAcpState(makeOrchestrator({ active })).phases?.[2]).toEqual({
      id: "implement",
      label: "Implement",
      status: "in_progress",
      detail: "applying review feedback",
    });
  });

  it("maps every pi-subagents status onto the approved subagent statuses", () => {
    setSubagents([
      { id: "a", description: "queued one", status: "queued" },
      { id: "b", description: "running one", status: "running" },
      { id: "c", description: "steered one", status: "steered" },
      { id: "d", description: "done one", status: "completed" },
      { id: "e", description: "broken one", status: "error" },
      { id: "f", description: "stopped one", status: "stopped" },
      { id: "g", description: "aborted one", status: "aborted" },
    ]);
    expect(
      buildAcpState(makeOrchestrator({ active: makeActive("plan") })).subagents,
    ).toEqual([
      { id: "a", label: "queued one", status: "pending" },
      { id: "b", label: "running one", status: "in_progress" },
      { id: "c", label: "steered one", status: "in_progress" },
      { id: "d", label: "done one", status: "completed" },
      { id: "e", label: "broken one", status: "failed" },
      { id: "f", label: "stopped one", status: "failed" },
      { id: "g", label: "aborted one", status: "failed" },
    ]);
  });

  it("falls back to type then id for a subagent label, and drops id-less records", () => {
    setSubagents([
      { id: "a", type: "explore", status: "running" },
      { id: "b", status: "running" },
      { description: "no id", status: "running" },
    ]);
    expect(buildAcpState(makeOrchestrator()).subagents).toEqual([
      { id: "a", label: "explore", status: "in_progress" },
      { id: "b", label: "b", status: "in_progress" },
    ]);
  });

  it("tolerates a missing subagents manager", () => {
    setSubagents(undefined);
    expect(buildAcpState(makeOrchestrator()).subagents).toEqual([]);
  });
});

describe("publishAcpState", () => {
  it("emits nothing outside ACP", () => {
    const orchestrator = makeOrchestrator({ active: makeActive("implement") });
    publishAcpState(orchestrator);
    expect(orchestrator.pi.appendEntry).not.toHaveBeenCalled();
  });

  it("emits the payload under the marker the pi-acp fork decodes", () => {
    process.env.PI_ACP = "1";
    const orchestrator = makeOrchestrator({ active: makeActive("implement") });
    publishAcpState(orchestrator);
    expect(orchestrator.pi.appendEntry).toHaveBeenCalledWith(
      PP_ACP_STATE_TYPE,
      {
        phase: "implement",
        phases: [
          { id: "brainstorm", label: "Brainstorm", status: "completed" },
          { id: "plan", label: "Plan", status: "completed" },
          { id: "implement", label: "Implement", status: "in_progress" },
        ],
        mode: "guided",
        status: "running",
        subagents: [],
      },
    );
  });

  it("emits a JSON-serializable payload", () => {
    process.env.PI_ACP = "1";
    const orchestrator = makeOrchestrator({ active: makeActive("implement") });
    publishAcpState(orchestrator);
    const payload = orchestrator.pi.appendEntry.mock.calls[0][1];
    expect(JSON.parse(JSON.stringify(payload))).toEqual(payload);
  });

  it("deduplicates until something material changes", () => {
    process.env.PI_ACP = "1";
    const orchestrator = makeOrchestrator({ active: makeActive("plan") });
    publishAcpState(orchestrator);
    publishAcpState(orchestrator);
    expect(orchestrator.pi.appendEntry).toHaveBeenCalledTimes(1);

    orchestrator.interactivePromptOpen = true;
    publishAcpState(orchestrator);
    expect(orchestrator.pi.appendEntry).toHaveBeenCalledTimes(2);
    expect(orchestrator.pi.appendEntry.mock.calls[1][1].status).toBe("waiting");
  });

  it("deduplicates a step change that does not alter the payload", () => {
    process.env.PI_ACP = "1";
    const orchestrator = makeOrchestrator({ active: makeActive("implement") });
    publishAcpState(orchestrator);
    orchestrator.active.state.step = "some_internal_step";
    publishAcpState(orchestrator);
    expect(orchestrator.pi.appendEntry).toHaveBeenCalledTimes(1);
  });

  it("re-emits when only the current phase's detail changes", () => {
    process.env.PI_ACP = "1";
    const orchestrator = makeOrchestrator({ active: makeActive("plan") });
    publishAcpState(orchestrator);
    orchestrator.active.state.step = "await_reviewers";
    publishAcpState(orchestrator);
    expect(orchestrator.pi.appendEntry).toHaveBeenCalledTimes(2);
    expect(
      orchestrator.pi.appendEntry.mock.calls[1][1].phases[1].detail,
    ).toBe("awaiting reviewers");
  });

  it("re-emits when a subagent changes status", () => {
    process.env.PI_ACP = "1";
    const orchestrator = makeOrchestrator({ active: makeActive("plan") });
    setSubagents([{ id: "a", description: "planner", status: "running" }]);
    publishAcpState(orchestrator);
    setSubagents([{ id: "a", description: "planner", status: "completed" }]);
    publishAcpState(orchestrator);
    expect(orchestrator.pi.appendEntry).toHaveBeenCalledTimes(2);
    expect(orchestrator.pi.appendEntry.mock.calls[1][1].subagents).toEqual([
      { id: "a", label: "planner", status: "completed" },
    ]);
  });

  it("walks a full phase→done transition through the approved statuses", () => {
    process.env.PI_ACP = "1";
    const orchestrator = makeOrchestrator();
    publishAcpState(orchestrator);
    orchestrator.active = makeActive("plan");
    publishAcpState(orchestrator);
    orchestrator.interactivePromptOpen = true;
    publishAcpState(orchestrator);
    orchestrator.interactivePromptOpen = false;
    orchestrator.active = makeActive("implement");
    publishAcpState(orchestrator);
    orchestrator.active = makeActive("done");
    publishAcpState(orchestrator);
    orchestrator.active = null;
    publishAcpState(orchestrator);

    expect(
      orchestrator.pi.appendEntry.mock.calls.map((c: any[]) => [
        c[1].phase,
        c[1].status,
      ]),
    ).toEqual([
      [undefined, "idle"],
      ["plan", "running"],
      ["plan", "waiting"],
      ["implement", "running"],
      ["done", "completed"],
      [undefined, "idle"],
    ]);
    expect(
      orchestrator.pi.appendEntry.mock.calls.map((c: any[]) =>
        phaseList(c[1]),
      ),
    ).toEqual([
      [],
      [
        ["brainstorm", "completed"],
        ["plan", "in_progress"],
        ["implement", "pending"],
      ],
      [
        ["brainstorm", "completed"],
        ["plan", "in_progress"],
        ["implement", "pending"],
      ],
      [
        ["brainstorm", "completed"],
        ["plan", "completed"],
        ["implement", "in_progress"],
      ],
      [
        ["brainstorm", "completed"],
        ["plan", "completed"],
        ["implement", "completed"],
      ],
      [],
    ]);
  });

  it("retries on the next change after appendEntry throws", () => {
    process.env.PI_ACP = "1";
    const appendEntry = vi.fn().mockImplementationOnce(() => {
      throw new Error("no session");
    });
    const orchestrator = makeOrchestrator({
      active: makeActive("plan"),
      pi: { appendEntry },
    });
    publishAcpState(orchestrator);
    publishAcpState(orchestrator);
    expect(appendEntry).toHaveBeenCalledTimes(2);
  });
});

function makeRpcUi(answers: { select?: string; input?: string[] }) {
  const inputs = [...(answers.input ?? [])];
  const calls: Array<{ method: string; title: string; options?: string[] }> =
    [];
  return {
    calls,
    ui: {
      async select(title: string, options: string[]) {
        calls.push({ method: "select", title, options });
        return answers.select;
      },
      async confirm(title: string) {
        calls.push({ method: "confirm", title });
        return false;
      },
      async input(title: string) {
        calls.push({ method: "input", title });
        return inputs.shift();
      },
      async editor(title: string) {
        calls.push({ method: "editor", title });
        return inputs.shift();
      },
      async custom() {
        return undefined;
      },
      onTerminalInput() {
        return () => {};
      },
      notify() {},
      setStatus() {},
      setWorkingMessage() {},
      setFooter() {},
      setWidget() {},
    },
  };
}

// The /pp menu and pp_phase_complete both reach the user exclusively through
// askUser, so these assert the workflow-critical interactions degrade onto
// standard primitives rather than the unsupported custom overlay.
describe("ask_user under ACP", () => {
  beforeEach(() => {
    process.env.PI_ACP = "1";
  });

  it("degrades a /pp-style single select onto ui.select", async () => {
    const { ui, calls } = makeRpcUi({ select: "Next" });
    const result = await askUser({ hasUI: true, ui } as any, {
      question: "/pp",
      options: [
        { title: "Next", description: "Advance" },
        { title: "Back", description: "Return" },
      ],
      allowFreeform: false,
      allowComment: false,
      allowMultiple: false,
    });
    expect(calls).toEqual([
      { method: "select", title: "/pp", options: ["Next", "Back"] },
    ]);
    expect(result).toEqual({ kind: "selection", selections: ["Next"] });
  });

  it("degrades a freeform ask onto ui.input", async () => {
    const { ui, calls } = makeRpcUi({ input: ["a note"] });
    const result = await askUser({ hasUI: true, ui } as any, {
      question: "Describe the issue",
      options: [],
      allowFreeform: true,
      allowComment: false,
      allowMultiple: false,
    });
    expect(calls).toEqual([{ method: "input", title: "Describe the issue" }]);
    expect(result).toEqual({ kind: "freeform", text: "a note" });
  });

  it("routes the freeform escape hatch of a select through ui.input", async () => {
    const { ui, calls } = makeRpcUi({
      select: "✏️ Type custom response...",
      input: ["something else"],
    });
    const result = await askUser({ hasUI: true, ui } as any, {
      question: "Pick",
      options: ["A", "B"],
      allowFreeform: true,
      allowComment: false,
      allowMultiple: false,
    });
    expect(calls.map((c) => c.method)).toEqual(["select", "input"]);
    expect(result).toEqual({ kind: "freeform", text: "something else" });
  });

  it("collects a selection comment through a second ui.input", async () => {
    const { ui, calls } = makeRpcUi({ select: "A", input: ["because"] });
    const result = await askUser({ hasUI: true, ui } as any, {
      question: "Pick",
      options: ["A", "B"],
      allowFreeform: false,
      allowComment: true,
      allowMultiple: false,
    });
    expect(calls.map((c) => c.method)).toEqual(["select", "input"]);
    expect(result).toEqual({
      kind: "selection",
      selections: ["A"],
      comment: "because",
    });
  });

  it("degrades a multi-select onto ui.input", async () => {
    const { ui, calls } = makeRpcUi({ input: ["A, C"] });
    const result = await askUser({ hasUI: true, ui } as any, {
      question: "Pick some",
      options: ["A", "B", "C"],
      allowFreeform: false,
      allowComment: false,
      allowMultiple: true,
    });
    expect(calls.map((c) => c.method)).toEqual(["input"]);
    expect(result).toEqual({ kind: "selection", selections: ["A", "C"] });
  });

  it("treats a cancelled dialog as no selection", async () => {
    const { ui } = makeRpcUi({});
    const result = await askUser({ hasUI: true, ui } as any, {
      question: "Pick",
      options: ["A"],
      allowFreeform: false,
      allowComment: false,
      allowMultiple: false,
    });
    expect(result).toBeNull();
    expect(isCancel(result)).toBe(false);
  });

  // The rich overlay cannot render in ACP: the host's RPC custom() resolves
  // undefined. The answer must still come from a standard primitive, and the
  // overlay's terminal-input listener must be released rather than leaked.
  it("answers from standard primitives when overlay mode is requested", async () => {
    const { ui, calls } = makeRpcUi({ select: "A" });
    const unsubscribe = vi.fn();
    vi.spyOn(ui, "onTerminalInput").mockReturnValue(unsubscribe);
    const result = await askUser({ hasUI: true, ui } as any, {
      question: "Pick",
      options: ["A"],
      allowFreeform: false,
      allowComment: false,
      allowMultiple: false,
      displayMode: "overlay",
    });
    expect(calls.map((c) => c.method)).toEqual(["select"]);
    expect(result).toEqual({ kind: "selection", selections: ["A"] });
    expect(unsubscribe).toHaveBeenCalled();
  });
});
