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

  // A binary the user installed matches their toolchain and their project; a
  // copy pi-pi downloaded once does not. The provisioned directory therefore
  // goes last, and a host binary installed later takes over immediately.
  it("appends the provision directory so a host binary always wins", () => {
    ensureProvisionDirOnPath("/opt/pi-bin");
    expect(process.env.PATH).toBe("/usr/bin:/bin:/opt/pi-bin:/opt/pi-bin/node/node_modules/.bin");
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
    expect(process.env.PATH).toBe("/usr/bin:/opt/pi-bin:/bin:/opt/pi-bin/node/node_modules/.bin");
  });

  it("copes with an empty PATH instead of leaving a stray separator", () => {
    process.env.PATH = "";
    ensureProvisionDirOnPath("/opt/pi-bin");
    expect(process.env.PATH).toBe("/opt/pi-bin:/opt/pi-bin/node/node_modules/.bin");
    expect(process.env.PATH!.startsWith(":")).toBe(false);
  });
});
