import { describe, it, expect, afterEach } from "vitest";
import { writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { generateMapWithIdentity } from "../src/readmap/mapper.js";

const tmp: string[] = [];
function mkTmp(ext: string): string {
  const p = join(tmpdir(), `mapper-identity-${randomBytes(6).toString("hex")}${ext}`);
  tmp.push(p);
  return p;
}

afterEach(async () => {
  for (const p of tmp.splice(0)) {
    try {
      await unlink(p);
    } catch {
      /* ignore */
    }
  }
});

describe("generateMapWithIdentity", () => {
  it("returns typescript identity for .ts files", async () => {
    const p = mkTmp(".ts");
    await writeFile(p, "export function hi(): number { return 1; }\n");
    const r = await generateMapWithIdentity(p);
    expect(r.mapperName).toBe("typescript");
    expect(r.mapperVersion).toBeGreaterThanOrEqual(1);
    expect(r.map).not.toBeNull();
  });

  it("returns markdown identity for .md files", async () => {
    const p = mkTmp(".md");
    await writeFile(p, "# heading\n");
    const r = await generateMapWithIdentity(p);
    expect(r.mapperName).toBe("markdown");
    expect(r.mapperVersion).toBeGreaterThanOrEqual(1);
  });

  it("returns fallback identity for unknown extensions", async () => {
    const p = mkTmp(".xyzunknown");
    await writeFile(p, "class Foo {}\n");
    const r = await generateMapWithIdentity(p);
    expect(["ctags", "fallback"]).toContain(r.mapperName);
    expect(r.mapperVersion).toBeGreaterThanOrEqual(1);
  });
});
