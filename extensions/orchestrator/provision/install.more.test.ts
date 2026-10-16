import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { provision, provisionDir, sha256, type ProvisionEffects } from "./install.js";
import { assetFor, platformKey, toolsFor } from "./manifest.js";

const PAYLOAD = Buffer.from("binary contents");

function effects(overrides: Partial<ProvisionEffects> = {}): ProvisionEffects {
  return {
    which: () => null,
    fetchBytes: async () => PAYLOAD,
    fetchText: async () => "",
    run: () => {},
    extract: (_archive, _kind, binary, dir) => {
      const path = join(dir, binary);
      writeFileSync(path, PAYLOAD);
      return path;
    },
    ...overrides,
  };
}

function release(version: string, assets: string[]): string {
  return JSON.stringify({
    tag_name: version,
    assets: assets.map((name) => ({ name, browser_download_url: `https://example.test/${name}` })),
  });
}

describe("provisionDir", () => {
  const saved = { bin: process.env.PI_PI_BIN_DIR, agent: process.env.PI_CODING_AGENT_DIR };

  afterEach(() => {
    for (const [key, value] of [["PI_PI_BIN_DIR", saved.bin], ["PI_CODING_AGENT_DIR", saved.agent]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("honours an explicit bin dir over everything else", () => {
    process.env.PI_PI_BIN_DIR = "/custom/bin";
    process.env.PI_CODING_AGENT_DIR = "/agent";
    expect(provisionDir()).toBe("/custom/bin");
  });

  it("lives under the agent dir, expanding a leading ~", () => {
    delete process.env.PI_PI_BIN_DIR;
    process.env.PI_CODING_AGENT_DIR = "/agent";
    expect(provisionDir()).toBe(join("/agent", "extensions", "pp", "bin"));
    process.env.PI_CODING_AGENT_DIR = "~/agent";
    expect(provisionDir()).toBe(join(homedir(), "agent", "extensions", "pp", "bin"));
    process.env.PI_CODING_AGENT_DIR = "~";
    expect(provisionDir()).toBe(join(homedir(), "extensions", "pp", "bin"));
  });

  it("defaults to ~/.pi/agent", () => {
    delete process.env.PI_PI_BIN_DIR;
    delete process.env.PI_CODING_AGENT_DIR;
    expect(provisionDir()).toBe(join(homedir(), ".pi", "agent", "extensions", "pp", "bin"));
  });
});

describe("provision edge cases", () => {
  let dir: string;
  const rg = toolsFor("rg");
  const asset = assetFor(rg[0], platformKey(), "1.0.0")!;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "provision-more-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("declares nothing to install for an unknown binary", async () => {
    expect(await provision(effects(), [], dir)).toEqual({ status: "unavailable", binary: "?", reason: "no candidate is declared for it" });
  });

  it("fails on a release without a tag", async () => {
    const outcome = await provision(effects({ fetchText: async () => JSON.stringify({ assets: [] }) }), rg, dir);
    expect(outcome).toEqual({ status: "failed", binary: "rg", reason: "no tag_name in the latest release of BurntSushi/ripgrep" });
  });

  it("names the asset a release is missing", async () => {
    const outcome = await provision(effects({ fetchText: async () => release("v1.0.0", ["other.tar.gz"]) }), rg, dir);
    expect(outcome.status).toBe("failed");
    expect((outcome as any).reason).toBe(`release 1.0.0 of BurntSushi/ripgrep has no asset named ${asset}`);
  });

  it("refuses an unparseable published digest rather than skipping verification", async () => {
    const extract = vi.fn();
    const outcome = await provision(
      effects({
        extract,
        fetchText: async (url) => (url.endsWith(".sha256") ? "not a digest" : release("1.0.0", [asset, `${asset}.sha256`])),
      }),
      rg,
      dir,
    );
    expect((outcome as any).reason).toBe(`could not parse the published digest in ${asset}.sha256`);
    expect(extract).not.toHaveBeenCalled();
  });

  it("discards staging when extraction throws", async () => {
    const discardStaging = vi.fn();
    const outcome = await provision(
      effects({
        discardStaging,
        extract: () => { throw new Error("corrupt archive"); },
        fetchText: async (url) => (url.endsWith(".sha256") ? sha256(PAYLOAD) : release("1.0.0", [asset, `${asset}.sha256`])),
      }),
      rg,
      dir,
    );
    expect(outcome).toEqual({ status: "failed", binary: "rg", reason: "corrupt archive" });
    expect(discardStaging).toHaveBeenCalledTimes(1);
  });

  it("installs an extracted binary that already sits at its final path as executable", async () => {
    const outcome = await provision(effects({ fetchText: async () => release("1.0.0", [asset]) }), rg, dir);
    expect(outcome).toEqual({ status: "installed", binary: "rg", path: join(dir, "rg"), verification: "none", version: "1.0.0" });
    expect(readFileSync(join(dir, "rg"))).toEqual(PAYLOAD);
  });
});

describe("npm installs", () => {
  let dir: string;
  const tool = toolsFor("bash-language-server");

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "provision-npm-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("is unavailable without npm", async () => {
    const outcome = await provision(effects(), tool, dir);
    expect(outcome).toEqual({ status: "failed", binary: "bash-language-server", reason: "npm is not on PATH" });
  });

  it("installs into a private prefix, never the global npm root", async () => {
    const run = vi.fn((_command: string, args: string[]) => {
      const bin = join(args[args.indexOf("--prefix") + 1], "node_modules", ".bin");
      mkdirSync(bin, { recursive: true });
      writeFileSync(join(bin, "bash-language-server"), "");
    });
    const outcome = await provision(effects({ which: (c) => (c === "npm" ? "/usr/bin/npm" : null), run }), tool, dir);
    const prefix = join(dir, "node");
    expect(run).toHaveBeenCalledWith("npm", ["install", "--prefix", prefix, "--no-audit", "--no-fund", "bash-language-server"], { timeoutMs: 300_000 });
    expect(run.mock.calls[0][1]).not.toContain("-g");
    expect(outcome).toEqual({
      status: "installed",
      binary: "bash-language-server",
      path: join(prefix, "node_modules", ".bin", "bash-language-server"),
      verification: "registry",
      version: "latest",
    });
  });

  it("does not claim success when npm exits cleanly but the bin is missing", async () => {
    const outcome = await provision(effects({ which: (c) => (c === "npm" ? "/usr/bin/npm" : null) }), tool, dir);
    expect(outcome.status).toBe("failed");
    expect((outcome as any).reason).toContain("npm installed bash-language-server but");
    expect(existsSync(join(dir, "node", "node_modules", ".bin", "bash-language-server"))).toBe(false);
  });

  it("collects the error of an npm run that throws", async () => {
    const outcome = await provision(
      effects({ which: (c) => (c === "npm" ? "/usr/bin/npm" : null), run: () => { throw new Error("E404"); } }),
      tool,
      dir,
    );
    expect(outcome).toEqual({ status: "failed", binary: "bash-language-server", reason: "E404" });
  });
});
