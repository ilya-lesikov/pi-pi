type ValidationResult = { ok: true } | { ok: false; errors: string[] };

const USER_REQUEST_REQUIRED_SECTIONS = ["Problem", "Constraints"] as const;
const USER_REQUEST_ALLOWED_SECTIONS = ["Problem", "Constraints"] as const;
const RESEARCH_REQUIRED_SECTIONS = ["Affected Code", "Architecture Context", "Constraints & Edge Cases"] as const;
const RESEARCH_ALLOWED_SECTIONS = ["Affected Code", "Architecture Context", "Constraints & Edge Cases", "Open Questions"] as const;
const PLAN_REQUIRED_SECTIONS = ["Scope", "Checklist"] as const;
export const PLAN_ALLOWED_SECTIONS = ["Scope", "Checklist", "Pattern constraints", "Blockers"] as const;
const PLACEHOLDER_PATTERNS = /^(?:[-*.…—]|tbd|todo|n\/a|na|none|\.{2,})$/i;

function splitLines(content: string): string[] {
  return content.split(/\r?\n/);
}

function getH1(content: string): { line: number; text: string } | null {
  const lines = splitLines(content);
  for (let i = 0; i < lines.length; i += 1) {
    const match = lines[i]?.match(/^\s*#\s+(.+?)\s*$/);
    if (match) {
      return { line: i + 1, text: match[1] };
    }
  }
  return null;
}

function getFirstHeading(content: string): { level: number; line: number; text: string } | null {
  const lines = splitLines(content);
  for (let i = 0; i < lines.length; i += 1) {
    const match = lines[i]?.match(/^\s*(#{1,6})\s+(.+?)\s*$/);
    if (match) {
      return { level: match[1].length, line: i + 1, text: match[2] };
    }
  }
  return null;
}

function normalizeH2Name(raw: string, allowedNames: readonly string[]): string {
  const trimmed = raw.replace(/:$/, "");
  for (const name of allowedNames) {
    if (trimmed === name || trimmed.startsWith(name + ":") || trimmed.startsWith(name + " ")) {
      return name;
    }
  }
  return raw;
}

function parseH2Sections(content: string, allowedNames?: readonly string[]): Array<{ name: string; line: number; start: number; end: number }> {
  const lines = splitLines(content);
  const sections: Array<{ name: string; line: number; start: number; end: number }> = [];

  for (let i = 0; i < lines.length; i += 1) {
    const match = lines[i]?.match(/^\s*##\s+(.+?)\s*$/);
    if (match) {
      const rawName = match[1];
      const name = allowedNames ? normalizeH2Name(rawName, allowedNames) : rawName;
      sections.push({
        name,
        line: i + 1,
        start: i + 1,
        end: lines.length,
      });
    }
  }

  for (let i = 0; i < sections.length; i += 1) {
    const next = sections[i + 1];
    sections[i]!.end = next ? next.line - 1 : lines.length;
  }

  return sections;
}

function sectionBody(content: string, section: { line: number; end: number }): string {
  const lines = splitLines(content);
  return lines.slice(section.line, section.end).join("\n");
}

function isPlaceholderContent(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length === 0 || PLACEHOLDER_PATTERNS.test(trimmed);
}

function hasNonEmptySectionBody(content: string, section: { line: number; end: number }): boolean {
  const body = sectionBody(content, section).trim();
  return !isPlaceholderContent(body);
}

function firstH2Line(content: string): number | null {
  const lines = splitLines(content);
  for (let i = 0; i < lines.length; i += 1) {
    if (/^\s*##\s+.+$/.test(lines[i] ?? "")) {
      return i + 1;
    }
  }
  return null;
}

function formatSectionList(sections: readonly string[], optional: readonly string[] = []): string {
  const required = sections.map((s) => `## ${s}`);
  const optionalParts = optional.map((s) => `## ${s} (optional)`);
  return [...required, ...optionalParts].join(", ");
}

export function validateUserRequest(content: string): ValidationResult {
  const errors: string[] = [];
  const h1 = getH1(content);
  const firstHeading = getFirstHeading(content);
  const expectedSections = formatSectionList(USER_REQUEST_REQUIRED_SECTIONS);

  if (!firstHeading) {
    errors.push("Missing required heading: # User Request. Expected first heading: # User Request");
  } else if (firstHeading.level !== 1 || firstHeading.text !== "User Request") {
    errors.push(
      `First heading is '${"#".repeat(firstHeading.level)} ${firstHeading.text}' on line ${firstHeading.line}. Expected first heading: # User Request`,
    );
  }

  const sections = parseH2Sections(content, USER_REQUEST_ALLOWED_SECTIONS);
  const sectionMap = new Map(sections.map((s) => [s.name, s]));

  for (const section of sections) {
    if (!USER_REQUEST_ALLOWED_SECTIONS.includes(section.name as (typeof USER_REQUEST_ALLOWED_SECTIONS)[number])) {
      errors.push(`Unexpected section: ## ${section.name}. Expected sections: ${expectedSections}`);
    }
  }

  for (const sectionName of USER_REQUEST_REQUIRED_SECTIONS) {
    if (!sectionMap.has(sectionName)) {
      errors.push(`Missing required section: ## ${sectionName}. Expected sections: ${expectedSections}`);
    }
  }

  const problem = sectionMap.get("Problem");
  if (problem && !hasNonEmptySectionBody(content, problem)) {
    errors.push("Section ## Problem is empty. Expected non-empty problem description.");
  }

  const constraints = sectionMap.get("Constraints");
  if (constraints && !hasNonEmptySectionBody(content, constraints)) {
    errors.push("Section ## Constraints is empty. Expected non-empty constraints.");
  }

  if (h1 && h1.text === "User Request") {
    const lines = splitLines(content);
    const start = h1.line;
    const firstH2 = firstH2Line(content);
    const endExclusive = firstH2 ? firstH2 - 1 : lines.length;
    const distillation = lines.slice(start, endExclusive).join("\n").trim();
    if (isPlaceholderContent(distillation)) {
      errors.push(
        "Distillation is missing between # User Request and the first ## section. Expected 1-3 non-empty sentences.",
      );
    }
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true };
}

export function validateResearch(content: string): ValidationResult {
  const errors: string[] = [];
  const expectedSections = formatSectionList(RESEARCH_REQUIRED_SECTIONS, ["Open Questions"]);
  const sections = parseH2Sections(content, RESEARCH_ALLOWED_SECTIONS);
  const sectionMap = new Map(sections.map((s) => [s.name, s]));

  for (const section of sections) {
    if (!RESEARCH_ALLOWED_SECTIONS.includes(section.name as (typeof RESEARCH_ALLOWED_SECTIONS)[number])) {
      errors.push(`Unexpected section: ## ${section.name}. Expected sections: ${expectedSections}`);
    }
  }

  for (const sectionName of RESEARCH_REQUIRED_SECTIONS) {
    const section = sectionMap.get(sectionName);
    if (!section) {
      errors.push(`Missing required section: ## ${sectionName}. Expected sections: ${expectedSections}`);
      continue;
    }
    if (!hasNonEmptySectionBody(content, section)) {
      errors.push(`Section ## ${sectionName} is empty. Expected non-empty content.`);
    }
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true };
}

// Heuristic scan for RESEARCH.md open questions that a task still needs a human
// to resolve. Autonomous-only gate (#1): the last interactive phase must leave
// nothing open before handing off to a phase that runs without a user. A line is
// flagged as unresolved when it carries NO DECIDED/ASSUMED resolution marker AND
// is either a list item (`-`/`*`/`N.` — a bullet in the Open Questions section is
// an open item by shape, including statement-style ones like "Need user sign-off")
// OR free prose that ends with "?" / starts with `Q<n>`. Kept lenient so it never
// blocks on framing prose (a non-list intro like "All resolved:"), whitespace,
// empty list markers, or an absent/empty section.
export function findUnresolvedOpenQuestions(content: string): string[] {
  const sections = parseH2Sections(content, RESEARCH_ALLOWED_SECTIONS);
  const section = sections.find((s) => s.name === "Open Questions");
  if (!section) return [];
  const body = sectionBody(content, section);
  const unresolved: string[] = [];
  for (const raw of splitLines(body)) {
    const line = raw.trim();
    if (line.length === 0) continue;
    const isListItem = /^(?:[-*]|\d+[.)])\s+/.test(line);
    const text = line.replace(/^(?:[-*]|\d+[.)])\s*/, "").trim();
    if (text.length === 0) continue;
    if (/\b(?:decided|assumed)\b/i.test(text)) continue;
    const looksLikeQuestion = isListItem || text.endsWith("?") || /^Q\d+\b/i.test(text);
    if (looksLikeQuestion) unresolved.push(text);
  }
  return unresolved;
}

export function validatePlan(content: string): ValidationResult {
  const errors: string[] = [];
  const h1 = getH1(content);
  const firstHeading = getFirstHeading(content);
  const expectedSections = formatSectionList(PLAN_REQUIRED_SECTIONS, ["Pattern constraints", "Blockers"]);

  if (!firstHeading) {
    errors.push("Missing required heading: # Plan. Expected first heading: # Plan");
  } else if (firstHeading.level !== 1 || firstHeading.text !== "Plan") {
    errors.push(
      `First heading is '${"#".repeat(firstHeading.level)} ${firstHeading.text}' on line ${firstHeading.line}. Expected first heading: # Plan`,
    );
  }

  const sections = parseH2Sections(content, PLAN_ALLOWED_SECTIONS);
  const sectionMap = new Map(sections.map((s) => [s.name, s]));

  for (const section of sections) {
    if (!PLAN_ALLOWED_SECTIONS.includes(section.name as (typeof PLAN_ALLOWED_SECTIONS)[number])) {
      errors.push(`Unexpected section: ## ${section.name}. Expected sections: ${expectedSections}`);
    }
  }

  for (const sectionName of PLAN_REQUIRED_SECTIONS) {
    if (!sectionMap.has(sectionName)) {
      errors.push(`Missing required section: ## ${sectionName}. Expected sections: ${expectedSections}`);
    }
  }

  const scope = sectionMap.get("Scope");
  if (scope && !hasNonEmptySectionBody(content, scope)) {
    errors.push("Section ## Scope is empty. Expected 2-4 lines summarizing scope and constraints.");
  }

  const lines = splitLines(content);
  const checklistMatches: Array<{ line: number; text: string }> = [];

  const checklistSection = sectionMap.get("Checklist");
  if (checklistSection) {
    const sectionLines = lines.slice(checklistSection.line, checklistSection.end);
    for (let i = 0; i < sectionLines.length; i += 1) {
      const line = sectionLines[i] ?? "";
      if (/^\s*- \[(?: |x|X)\]/.test(line)) {
        const globalLine = checklistSection.line + i + 1;
        checklistMatches.push({ line: globalLine, text: line.trim() });

        let hasDoneWhen = /done when\s*:/i.test(line);
        if (!hasDoneWhen) {
          for (let j = i + 1; j < sectionLines.length; j += 1) {
            const nextLine = sectionLines[j] ?? "";
            if (/^\s*- \[(?: |x|X)\]/.test(nextLine) || nextLine.trim() === "") break;
            if (/done when\s*:/i.test(nextLine)) {
              hasDoneWhen = true;
              break;
            }
          }
        }

        if (!hasDoneWhen) {
          errors.push(`Checklist item on line ${globalLine} missing 'Done when:' clause: '${line.trim()}'`);
        }
      }
    }
  }

  if (checklistMatches.length === 0) {
    errors.push(
      "Checklist has no items. Expected at least one checklist item matching '- [ ]' or '- [x]' with 'Done when:' clause.",
    );
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true };
}

export function validateArtifact(content: string): ValidationResult {
  const errors: string[] = [];
  const firstHeading = getFirstHeading(content);

  if (!firstHeading) {
    errors.push("Missing required heading: # <Title>. Artifact must start with a top-level heading.");
  } else if (firstHeading.level !== 1) {
    errors.push(
      `First heading is '${"#".repeat(firstHeading.level)} ${firstHeading.text}' on line ${firstHeading.line}. Expected a top-level heading: # <Title>`,
    );
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true };
}
