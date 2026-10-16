import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { nodeProvisionEffects as effects } from "./effects.js";

let server: Server;
let base: string;
let lastHeaders: Record<string, string | string[] | undefined> = {};

beforeAll(async () => {
  server = createServer((req, res) => {
    lastHeaders = req.headers;
    if (req.url === "/text") return void res.end("hello text");
    if (req.url === "/bytes") return void res.end(Buffer.from([0, 1, 2, 255]));
    if (req.url === "/redirect") {
      res.writeHead(302, { location: "/text" });
      return void res.end();
    }
    res.writeHead(404);
    res.end("nope");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

const dirs: string[] = [];
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "pp-effects-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  effects.discardStaging?.();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("fetching", () => {
  it("returns text and identifies itself, as GitHub's API requires", async () => {
    expect(await effects.fetchText(`${base}/text`)).toBe("hello text");
    expect(lastHeaders["user-agent"]).toBe("pi-pi");
  });

  it("returns the exact bytes of a binary body", async () => {
    expect([...(await effects.fetchBytes(`${base}/bytes`))]).toEqual([0, 1, 2, 255]);
  });

  it("follows redirects, as release asset URLs always redirect", async () => {
    expect(await effects.fetchText(`${base}/redirect`)).toBe("hello text");
  });

  it("throws on a non-2xx status instead of returning the error page", async () => {
    await expect(effects.fetchText(`${base}/missing`)).rejects.toThrow(`GET ${base}/missing → HTTP 404`);
    await expect(effects.fetchBytes(`${base}/missing`)).rejects.toThrow("HTTP 404");
  });
});

describe("which", () => {
  it("resolves a command on PATH to its first path", () => {
    const found = effects.which("sh");
    expect(found).toMatch(/\/sh$/);
  });

  it("returns null for an unknown command", () => {
    expect(effects.which("pp-definitely-not-a-command-xyz")).toBeNull();
  });
});

describe("run", () => {
  it("runs in the given cwd", () => {
    const dir = scratch();
    effects.run("sh", ["-c", "echo ok > marker"], { cwd: dir });
    expect(readFileSync(join(dir, "marker"), "utf-8")).toBe("ok\n");
  });

  it("throws on a non-zero exit", () => {
    expect(() => effects.run("sh", ["-c", "exit 3"])).toThrow();
  });
});

describe("extract", () => {
  const payload = Buffer.from("#!/bin/sh\necho hi\n");

  it("gunzips a .gz asset into a file named after the binary", () => {
    const path = effects.extract(gzipSync(payload), "gz", "tool", scratch());
    expect(path.endsWith("/tool")).toBe(true);
    expect(readFileSync(path)).toEqual(payload);
  });

  function packTree(): string {
    const src = scratch();
    mkdirSync(join(src, "tool-1.0", "bin"), { recursive: true });
    writeFileSync(join(src, "tool-1.0", "bin", "tool"), payload);
    writeFileSync(join(src, "tool-1.0", "README"), "readme");
    return src;
  }

  it("finds the binary nested inside a tar.gz release", () => {
    const src = packTree();
    const archive = join(src, "a.tar.gz");
    execFileSync("tar", ["-czf", archive, "-C", src, "tool-1.0"]);
    const path = effects.extract(readFileSync(archive), "tar.gz", "tool", scratch());
    expect(path).toMatch(/tool-1\.0\/bin\/tool$/);
    expect(readFileSync(path)).toEqual(payload);
  });

  it("takes a raw asset as the binary itself", () => {
    const path = effects.extract(payload, "raw", "tool", scratch());
    expect(path.endsWith("/tool")).toBe(true);
    expect(readFileSync(path)).toEqual(payload);
  });

  it("reports an archive that does not contain the binary", () => {
    const src = packTree();
    const archive = join(src, "a.tar.gz");
    execFileSync("tar", ["-czf", archive, "-C", src, "tool-1.0"]);
    expect(() => effects.extract(readFileSync(archive), "tar.gz", "other", scratch())).toThrow("no other inside the downloaded archive");
  });

  it("does not look deeper than release archives nest", () => {
    const src = scratch();
    const deep = join(src, "a", "b", "c", "d", "e");
    mkdirSync(deep, { recursive: true });
    writeFileSync(join(deep, "tool"), payload);
    const archive = join(src, "a.tar.gz");
    execFileSync("tar", ["-czf", archive, "-C", src, "a"]);
    expect(() => effects.extract(readFileSync(archive), "tar.gz", "tool", scratch())).toThrow("no tool inside");
  });

  it("rejects an archive kind it does not know", () => {
    expect(() => effects.extract(payload, "rar", "tool", scratch())).toThrow("unsupported archive kind: rar");
  });

  it("discardStaging removes every staging directory, even after a failed extract", () => {
    const ok = effects.extract(gzipSync(payload), "gz", "tool", scratch());
    expect(() => effects.extract(payload, "rar", "tool", scratch())).toThrow();
    expect(existsSync(dirname(ok))).toBe(true);
    effects.discardStaging!();
    expect(existsSync(dirname(ok))).toBe(false);
  });
});
