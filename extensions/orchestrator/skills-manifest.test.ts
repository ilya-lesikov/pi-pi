import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  discoverSkills,
  enabledSkills,
  renderSkillsManifest,
  skillId,
  type SkillsConfig,
} from "./skills-manifest.js";

const OFF: SkillsConfig = { loadProject: false, loadGlobal: false, disabled: [] };

// Write a SKILL.md with YAML frontmatter into <dir>/<name>/SKILL.md.
function writeSkill(root: string, name: string, description: string) {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\nbody\n`);
}

describe("skills-manifest", () => {
  let root: string;
  let cwd: string;
  const prevEnv = process.env.PI_CODING_AGENT_DIR;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "skills-"));
    cwd = join(root, "proj");
    mkdirSync(join(cwd, ".pi", "skills"), { recursive: true });
    mkdirSync(join(root, "agent", "skills"), { recursive: true });
    process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  });
  afterEach(() => {
    if (prevEnv === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevEnv;
    rmSync(root, { recursive: true, force: true });
  });

  it("discovers nothing when both scopes are off", () => {
    writeSkill(join(cwd, ".pi", "skills"), "alpha", "does alpha");
    expect(discoverSkills(cwd, OFF)).toHaveLength(0);
  });

  it("discovers project skills when loadProject is on", () => {
    writeSkill(join(cwd, ".pi", "skills"), "alpha", "does alpha");
    const found = discoverSkills(cwd, { ...OFF, loadProject: true });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ scope: "project", name: "alpha", description: "does alpha" });
    expect(found[0].id).toBe(skillId("project", "alpha"));
  });

  it("discovers global skills when loadGlobal is on", () => {
    writeSkill(join(root, "agent", "skills"), "beta", "does beta");
    const found = discoverSkills(cwd, { ...OFF, loadGlobal: true });
    expect(found.some((s) => s.scope === "global" && s.name === "beta")).toBe(true);
  });

  it("enabledSkills excludes ids in the disabled list", () => {
    writeSkill(join(cwd, ".pi", "skills"), "alpha", "a");
    writeSkill(join(cwd, ".pi", "skills"), "gamma", "g");
    const cfg = { loadProject: true, loadGlobal: false, disabled: [skillId("project", "alpha")] };
    const enabled = enabledSkills(cwd, cfg);
    expect(enabled.map((s) => s.name).sort()).toEqual(["gamma"]);
    // discoverSkills still returns BOTH (the List submenu needs the full set).
    expect(discoverSkills(cwd, cfg)).toHaveLength(2);
  });

  it("renders a name+description+path manifest, bodies not inlined", () => {
    writeSkill(join(cwd, ".pi", "skills"), "alpha", "does alpha");
    const manifest = renderSkillsManifest(discoverSkills(cwd, { ...OFF, loadProject: true }));
    expect(manifest).toContain("<skills>");
    expect(manifest).toContain("alpha");
    expect(manifest).toContain("does alpha");
    expect(manifest).toContain("SKILL.md");
    expect(manifest).not.toContain("body"); // full body is loaded on demand, not inlined
  });

  it("renders empty string when there are no enabled skills", () => {
    expect(renderSkillsManifest([])).toBe("");
  });
});
