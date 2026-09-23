import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { parseChecksum, provision, sha256, type ProvisionEffects } from "./install.js";
import { assetFor, eagerTools, platformKey, toolsFor, toolsForExtension, TOOLS } from "./manifest.js";

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

describe("provisioning decisions", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "provision-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("never touches the network when the binary already resolves", async () => {
    const fetchBytes = vi.fn();
    const outcome = await provision(
      effects({ which: () => "/usr/bin/rg", fetchBytes }),
      toolsFor("rg"),
      dir,
    );

    expect(outcome).toEqual({ status: "present", binary: "rg", path: "/usr/bin/rg" });
    expect(fetchBytes).not.toHaveBeenCalled();
  });

  it("verifies a published digest and records that it did", async () => {
    const asset = assetFor(toolsFor("rg")[0], platformKey(), "15.2.0")!;
    const outcome = await provision(
      effects({
        fetchText: async (url) =>
          url.endsWith(".sha256") ? `${sha256(PAYLOAD)}  ${asset}` : release("15.2.0", [asset, `${asset}.sha256`]),
      }),
      toolsFor("rg"),
      dir,
    );

    expect(outcome.status).toBe("installed");
    expect(outcome).toMatchObject({ verification: "checksum", version: "15.2.0" });
  });

  it("refuses to install when the digest does not match", async () => {
    const asset = assetFor(toolsFor("rg")[0], platformKey(), "15.2.0")!;
    const outcome = await provision(
      effects({
        fetchText: async (url) =>
          url.endsWith(".sha256") ? `${"0".repeat(64)}  ${asset}` : release("15.2.0", [asset, `${asset}.sha256`]),
      }),
      toolsFor("rg"),
      dir,
    );

    expect(outcome.status).toBe("failed");
    expect((outcome as any).reason).toMatch(/digest mismatch/);
  });

  it("reports verification honestly as none when the publisher ships no digest", async () => {
    // rust-analyzer publishes release assets without a checksum file. Claiming
    // otherwise would misrepresent what was actually checked.
    const standalone = toolsFor("rust-analyzer").find((tool) => tool.source.kind === "github")!;
    const asset = assetFor(standalone, platformKey(), "2026-09-21")!;
    const outcome = await provision(
      effects({ fetchText: async () => release("2026-09-21", [asset]) }),
      [standalone],
      dir,
    );

    expect(outcome).toMatchObject({ status: "installed", verification: "none" });
  });

  it("falls through to the next candidate when a toolchain is absent", async () => {
    const candidates = toolsFor("rust-analyzer");
    expect(candidates[0].source.kind).toBe("toolchain");

    const asset = assetFor(candidates[1], platformKey(), "2026-09-21")!;
    const run = vi.fn();
    const outcome = await provision(
      effects({ which: () => null, run, fetchText: async () => release("2026-09-21", [asset]) }),
      candidates,
      dir,
    );

    // rustup is absent, so the toolchain candidate is skipped without running.
    expect(run).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ status: "installed", verification: "none" });
  });

  it("reports the rustup-shim shape: the toolchain succeeds, the binary still is not there", async () => {
    const toolchain = toolsFor("rust-analyzer").find((tool) => tool.source.kind === "toolchain")!;
    const outcome = await provision(
      effects({ which: (cmd) => (cmd === "rustup" ? "/home/u/.cargo/bin/rustup" : null) }),
      [toolchain],
      dir,
    );

    expect(outcome.status).toBe("failed");
    expect((outcome as any).reason).toMatch(/still not on PATH/);
  });

  it("says which platform is unserved rather than failing opaquely", async () => {
    const outcome = await provision(
      effects({ fetchText: async () => release("15.2.0", ["ripgrep-15.2.0-sparc-unknown-solaris.tar.gz"]) }),
      toolsFor("rg"),
      dir,
    );

    expect(outcome.status).toBe("failed");
    expect((outcome as any).reason).toMatch(/no asset named|publishes no asset/);
  });

  it("gives up with every candidate's reason, not just the last", async () => {
    const outcome = await provision(
      effects({ fetchText: async () => { throw new Error("network unreachable"); } }),
      toolsFor("rust-analyzer"),
      dir,
    );

    expect(outcome.status).toBe("failed");
    expect((outcome as any).reason).toMatch(/rustup is not on PATH/);
    expect((outcome as any).reason).toMatch(/network unreachable/);
  });
});

describe("the digest format publishers actually ship", () => {
  it("accepts the sha256sum form and the bare digest", () => {
    const digest = "a".repeat(64);
    expect(parseChecksum(`${digest}  ripgrep.tar.gz`)).toBe(digest);
    expect(parseChecksum(`${digest}\n`)).toBe(digest);
    expect(parseChecksum(`${digest.toUpperCase()}  f`)).toBe(digest);
  });

  it("rejects anything that is not a digest instead of guessing", () => {
    expect(parseChecksum("")).toBeNull();
    expect(parseChecksum("not a checksum")).toBeNull();
    expect(parseChecksum("abc123  short.tar.gz")).toBeNull();
    expect(parseChecksum("<!DOCTYPE html>")).toBeNull();
  });
});

describe("the manifest", () => {
  it("provisions search and the code graph eagerly, language servers on demand", () => {
    expect(eagerTools().map((tool) => tool.binary).sort()).toEqual(["codebase-memory-mcp", "rg"]);
    for (const tool of TOOLS) {
      if (!tool.eager) expect(tool.extensions?.length ?? 0).toBeGreaterThan(0);
    }
  });

  it("routes a file extension to the servers that handle it", () => {
    expect(toolsForExtension(".rs").map((tool) => tool.binary)).toEqual(["rust-analyzer", "rust-analyzer"]);
    expect(toolsForExtension(".go").map((tool) => tool.binary)).toEqual(["gopls"]);
    expect(toolsForExtension(".ts")[0].binary).toBe("typescript-language-server");
    // A language pi-pi does not provision is distinct from one that failed.
    expect(toolsForExtension(".java")).toEqual([]);
  });

  it("publishes an asset for every platform pi-pi is expected to run on", () => {
    for (const key of ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64", "win32-x64"]) {
      expect(assetFor(toolsFor("rg")[0], key, "15.2.0")).toBeTruthy();
    }
  });

  it("prefers the toolchain over a standalone binary where one owns the version", () => {
    // A standalone rust-analyzer beside a rustup toolchain can disagree with
    // the project's Rust version, so rustup is tried first.
    expect(toolsFor("rust-analyzer")[0].source.kind).toBe("toolchain");
  });
});
