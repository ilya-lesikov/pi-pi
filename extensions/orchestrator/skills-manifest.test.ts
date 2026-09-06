import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

  it("ships bundled guidance", () => {
    const bundled = listLayeredSkills(cwd).filter((skill) => skill.layer === "bundled");
    expect(bundled.length).toBeGreaterThan(0);
    expect(bundled.every((skill) => skill.filePath.startsWith(bundledSkillsDir()))).toBe(true);
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

  it("lists available names for unknown skills", () => {
    writeSkill(global, "alpha", "Alpha guidance");
    expect(() => loadLayeredSkill("missing", cwd)).toThrow(/Available skills: alpha/);
  });
});
