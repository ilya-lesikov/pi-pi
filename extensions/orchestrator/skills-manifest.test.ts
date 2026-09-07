import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bundledSkillsDir, listLayeredSkills, loadLayeredSkill, resolveLayeredSkill } from "./skills-manifest.js";

function writeSkill(root: string, name: string, description: string, body = "body"): void {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`);
}

describe("layered skills", () => {
  let root: string;
  let cwd: string;
  let global: string;
  let previous: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "pi-pi-skills-"));
    cwd = join(root, "project");
    global = join(root, "global");
    mkdirSync(join(cwd, ".pi", "skills"), { recursive: true });
    mkdirSync(global, { recursive: true });
    previous = process.env.PI_SKILLS_DIR;
    process.env.PI_SKILLS_DIR = global;
  });

  afterEach(() => {
    if (previous === undefined) delete process.env.PI_SKILLS_DIR;
    else process.env.PI_SKILLS_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  });

  it("ships a focused general-purpose catalog", () => {
    const bundled = listLayeredSkills(cwd).filter((skill) => skill.layer === "bundled");
    expect(bundled.map((skill) => skill.name)).toEqual([
      "repository-work",
      "research-and-design",
      "software-engineering",
    ]);
    expect(bundled.every((skill) => skill.filePath.startsWith(bundledSkillsDir()))).toBe(true);
    expect(loadLayeredSkill("software-engineering", cwd).document).toContain("## Verification gate");
    expect(loadLayeredSkill("repository-work", cwd).document).toContain("conventional-commit type");
  });

  it("resolves project over global over bundled", () => {
    const name = listLayeredSkills(cwd).find((skill) => skill.layer === "bundled")!.name;
    writeSkill(global, name, "global");
    expect(resolveLayeredSkill(name, cwd)).toMatchObject({ layer: "global", shadows: ["bundled"] });
    writeSkill(join(cwd, ".pi", "skills"), name, "project");
    expect(resolveLayeredSkill(name, cwd)).toMatchObject({ layer: "project", description: "project", shadows: ["global", "bundled"] });
  });

  it("supports flat markdown files as well as skill directories", () => {
    writeFileSync(join(global, "research.md"), "---\nname: research\ndescription: Source-backed research\n---\n\nVerify sources.\n");
    expect(resolveLayeredSkill("research", cwd)).toMatchObject({ layer: "global" });
  });

  it("loads a canonical tagged document without activation state", () => {
    writeSkill(join(cwd, ".pi", "skills"), "alpha", "Alpha guidance", "Do alpha.");
    const first = loadLayeredSkill("alpha", cwd);
    const second = loadLayeredSkill("alpha", cwd);
    expect(first.document).toBe('<skill name="alpha" source="project">\nDo alpha.\n</skill>');
    expect(second.document).toBe(first.document);
    expect(first.document).not.toContain("description:");
  });

  it("reloads edited guidance", () => {
    writeSkill(global, "alpha", "Alpha guidance", "old");
    expect(loadLayeredSkill("alpha", cwd).document).toContain("old");
    writeSkill(global, "alpha", "Alpha guidance", "new");
    expect(loadLayeredSkill("alpha", cwd).document).toContain("new");
  });

  it("ignores invalid metadata without hiding valid skills", () => {
    writeFileSync(join(global, "bad.md"), "---\nname: Bad Name\ndescription: invalid\n---\n\nbody\n");
    writeFileSync(join(global, "empty.md"), "---\nname: empty\n---\n\nbody\n");
    writeSkill(global, "valid", "Valid guidance");
    expect(resolveLayeredSkill("Bad Name", cwd)).toBeUndefined();
    expect(resolveLayeredSkill("empty", cwd)).toBeUndefined();
    expect(resolveLayeredSkill("valid", cwd)).toMatchObject({ layer: "global" });
  });

  it("ignores skill symlinks that escape their configured layer", () => {
    const outside = join(root, "outside");
    writeSkill(outside, "escaped", "Escaped guidance");
    symlinkSync(join(outside, "escaped"), join(global, "escaped"), "dir");
    expect(resolveLayeredSkill("escaped", cwd)).toBeUndefined();
  });

  it("lists available names for unknown skills", () => {
    writeSkill(global, "alpha", "Alpha guidance");
    expect(() => loadLayeredSkill("missing", cwd)).toThrow(/Available skills: alpha/);
  });
});
