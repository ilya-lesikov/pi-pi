import { expect } from "vitest";

export type TextMatch = string | RegExp | ((value: string) => boolean);

export interface MenuExpectation {
  question?: TextMatch;
  options?: {
    exact?: TextMatch[];
    include?: TextMatch[];
    exclude?: TextMatch[];
  };
  // When set, the harness returns a cancel (as askUser/isCancel would on ESC)
  // instead of choosing an option. `choose` is ignored in that case.
  cancel?: "user" | "timeout" | "signal";
  choose?: TextMatch | ((options: string[]) => string);
}

export interface MenuTranscriptEntry {
  question: string;
  options: Array<{ title: string; description?: string }>;
  chosen: string;
}

export interface AskUserHarness {
  transcript: MenuTranscriptEntry[];
  expect(step: MenuExpectation): AskUserHarness;
  handle(opts: any): Promise<{ kind: "selection"; selections: [string] } | { __cancel: true; reason: "user" | "timeout" | "signal" }>;
  assertDone(): void;
}

interface MenuOption {
  title: string;
  description?: string;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stringifyMatcher(matcher: TextMatch | undefined): string {
  if (matcher === undefined) return "<none>";
  if (typeof matcher === "string") return JSON.stringify(matcher);
  if (matcher instanceof RegExp) return matcher.toString();
  return "<function>";
}

function matchText(matcher: TextMatch, value: string): boolean {
  if (typeof matcher === "string") return value === matcher;
  if (matcher instanceof RegExp) return matcher.test(value);
  return matcher(value);
}

function renderMenu(question: string, options: MenuOption[]): string {
  const lines = options.map((option) => {
    if (!option.description) return `- ${option.title}`;
    return `- ${option.title} — ${option.description}`;
  });
  return `question=${JSON.stringify(question)}\noptions:\n${lines.join("\n")}`;
}

export function createAskUserHarness(): AskUserHarness {
  const queue: MenuExpectation[] = [];
  const transcript: MenuTranscriptEntry[] = [];

  return {
    transcript,
    expect(step: MenuExpectation) {
      queue.push(step);
      return this;
    },
    async handle(opts: any) {
      const question = String(opts?.question ?? "");
      const options: MenuOption[] = (Array.isArray(opts?.options) ? opts.options : []).map((option: any): MenuOption => {
        if (typeof option === "string") return { title: option };
        return {
          title: String(option?.title ?? ""),
          description: option?.description === undefined ? undefined : String(option.description),
        };
      });
      const titles: string[] = options.map((option: MenuOption) => option.title);

      if (queue.length === 0) {
        throw new Error(`Unexpected menu: ${renderMenu(question, options)}`);
      }

      const expected = queue.shift()!;

      if (expected.question && !matchText(expected.question, question)) {
        throw new Error(
          `Question mismatch: expected ${stringifyMatcher(expected.question)}, actual ${JSON.stringify(question)}\n${renderMenu(question, options)}`,
        );
      }

      if (expected.options?.include) {
        for (const include of expected.options.include) {
          const found = titles.some((title: string) => matchText(include, title));
          if (!found) {
            throw new Error(
              `Missing expected option ${stringifyMatcher(include)}\n${renderMenu(question, options)}`,
            );
          }
        }
      }

      if (expected.options?.exclude) {
        for (const exclude of expected.options.exclude) {
          const found = titles.some((title: string) => matchText(exclude, title));
          if (found) {
            throw new Error(
              `Found excluded option ${stringifyMatcher(exclude)}\n${renderMenu(question, options)}`,
            );
          }
        }
      }

      if (expected.options?.exact) {
        expect(titles.length).toBe(expected.options.exact.length);
        for (let i = 0; i < expected.options.exact.length; i += 1) {
          const matcher = expected.options.exact[i]!;
          const actual = titles[i] ?? "";
          if (!matchText(matcher, actual)) {
            throw new Error(
              `Exact options mismatch at index ${i}: expected ${stringifyMatcher(matcher)}, actual ${JSON.stringify(actual)}\n${renderMenu(question, options)}`,
            );
          }
        }
      }

      if (expected.cancel) {
        transcript.push({ question, options, chosen: `<cancel:${expected.cancel}>` });
        return { __cancel: true, reason: expected.cancel };
      }

      if (expected.choose === undefined) {
        throw new Error(`Menu expectation is missing a chooser\n${renderMenu(question, options)}`);
      }

      let chosen: string;
      if (typeof expected.choose === "function") {
        const maybeChoice = (expected.choose as (options: string[]) => unknown)(titles);
        if (typeof maybeChoice === "string") {
          chosen = maybeChoice;
        } else {
          const matcher = expected.choose as (value: string) => boolean;
          const picked = titles.find((title: string) => matcher(title));
          if (!picked) {
            throw new Error(`No option matched chooser function\n${renderMenu(question, options)}`);
          }
          chosen = picked;
        }
      } else {
        const picked = titles.find((title: string) => matchText(expected.choose as TextMatch, title));
        if (!picked) {
          throw new Error(
            `No option matched chooser ${stringifyMatcher(expected.choose as TextMatch)}\n${renderMenu(question, options)}`,
          );
        }
        chosen = picked;
      }

      if (!titles.includes(chosen)) {
        throw new Error(`Chosen option not found: ${JSON.stringify(chosen)}\n${renderMenu(question, options)}`);
      }

      transcript.push({ question, options, chosen });

      return { kind: "selection", selections: [chosen] };
    },
    assertDone() {
      if (queue.length > 0) {
        const next = queue[0]!;
        throw new Error(
          `Unconsumed menu expectations: ${queue.length}. Next expected question=${stringifyMatcher(next.question)} choose=${stringifyMatcher(
            typeof next.choose === "function" ? undefined : next.choose,
          )}`,
        );
      }
    },
  };
}

export const m = {
  taskMenu: (type: string, phase: string) =>
    (q: string) => q.includes(`Task: ${type}`) && q.includes(`Phase: ${phase}`),
  anyTaskMenu: (q: string) => q.startsWith("/pp"),
  preset: (name: string) => new RegExp(`^${escapeRegExp(name)}(?: \\[default\\])?$`),
  autoReview: /^Auto review(?: \(pass \d+\))?$/,
};

export function expectActiveTaskNext(menu: AskUserHarness, choose: string): void {
  menu.expect({ question: m.anyTaskMenu, options: { include: ["Next"] }, choose: "Next" });
  menu.expect({ question: "Next", options: { include: [choose] }, choose });
}

export function expectBrainstormToPlan(menu: AskUserHarness): void {
  expectActiveTaskNext(menu, "Continue to plan & implement");
  menu.expect({ question: "Planner preset", options: { include: [m.preset("regular"), "Back"] }, choose: m.preset("regular") });
}

export function expectPlanToImplement(menu: AskUserHarness): void {
  expectActiveTaskNext(menu, "Continue to implement");
}

export function expectImplementToDone(menu: AskUserHarness): void {
  expectActiveTaskNext(menu, "Complete");
}

export function expectQuickMenu(menu: AskUserHarness, choose: string): void {
  menu.expect({ question: m.anyTaskMenu, options: { include: [choose] }, choose });
}

export function expectReviewAuto(menu: AskUserHarness, preset = "regular"): void {
  menu.expect({ question: m.anyTaskMenu, options: { include: ["Review"] }, choose: "Review" });
  menu.expect({ question: "Review", options: { include: [m.autoReview] }, choose: m.autoReview });
  menu.expect({ question: "Review preset", options: { include: [m.preset(preset), "Back"] }, choose: m.preset(preset) });
}

export function expectReviewOnMyOwn(menu: AskUserHarness): void {
  menu.expect({ question: m.anyTaskMenu, options: { include: ["Review"] }, choose: "Review" });
  menu.expect({ question: "Review", options: { include: ["Review on my own"] }, choose: "Review on my own" });
}

export function expectPpStartImplementAutonomous(menu: AskUserHarness): void {
  menu.expect({ question: "/pp", options: { include: ["Task"] }, choose: "Task" });
  menu.expect({ question: "Task", options: { include: ["Implement"] }, choose: "Implement" });
  menu.expect({ question: "Implement", options: { include: ["New"] }, choose: "New" });
  menu.expect({ question: "Mode", options: { include: ["Guided", "Autonomous", "Back"] }, choose: "Autonomous" });
  menu.expect({ question: "Autonomous", options: { include: ["Start", "Back"] }, choose: "Start" });
}
