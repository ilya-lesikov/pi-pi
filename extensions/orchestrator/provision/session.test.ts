import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ensureProvisionDirOnPath } from "./session.js";

describe("making installed binaries reachable", () => {
  const originalPath = process.env.PATH;

  beforeEach(() => {
    process.env.PATH = "/usr/bin:/bin";
  });

  afterEach(() => {
    process.env.PATH = originalPath;
  });

  it("prepends the provision directory so it wins over a stale copy elsewhere", () => {
    ensureProvisionDirOnPath("/opt/pi-bin");
    expect(process.env.PATH).toBe("/opt/pi-bin:/opt/pi-bin/node/node_modules/.bin:/usr/bin:/bin");
  });

  // npm installs into a private prefix, not beside the downloaded binaries. An
  // installed language server is unreachable unless that .bin is on PATH too.
  it("puts the npm prefix's .bin on PATH as well", () => {
    ensureProvisionDirOnPath("/opt/pi-bin");
    expect(process.env.PATH!.split(":")).toContain("/opt/pi-bin/node/node_modules/.bin");
  });

  it("is idempotent — a session restart must not grow PATH without bound", () => {
    ensureProvisionDirOnPath("/opt/pi-bin");
    ensureProvisionDirOnPath("/opt/pi-bin");
    ensureProvisionDirOnPath("/opt/pi-bin");
    expect(process.env.PATH!.split(":").filter((p) => p === "/opt/pi-bin")).toHaveLength(1);
  });

  it("leaves an already-present entry where the user put it", () => {
    process.env.PATH = "/usr/bin:/opt/pi-bin:/bin";
    ensureProvisionDirOnPath("/opt/pi-bin");
    expect(process.env.PATH).toBe("/opt/pi-bin/node/node_modules/.bin:/usr/bin:/opt/pi-bin:/bin");
  });

  it("copes with an empty PATH instead of leaving a stray separator", () => {
    process.env.PATH = "";
    ensureProvisionDirOnPath("/opt/pi-bin");
    expect(process.env.PATH).toBe("/opt/pi-bin:/opt/pi-bin/node/node_modules/.bin");
    expect(process.env.PATH!.startsWith(":")).toBe(false);
  });
});
