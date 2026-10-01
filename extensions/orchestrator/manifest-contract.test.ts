import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

// Packages the extension loader supplies to extensions at runtime. Listing one
// in `dependencies` makes npm install a second copy that bypasses the loader's
// aliases, so the extension and the host end up with distinct runtime modules
// of the same library — and pi warns about exactly this at load. They belong in
// `peerDependencies` with a "*" range, or nowhere at all when nothing imports
// them outside type positions.
const HOST_PROVIDED = ["typebox", "@sinclair/typebox", "@earendil-works/pi-ai", "@earendil-works/pi-coding-agent", "@earendil-works/pi-tui"];

const manifest = JSON.parse(
  readFileSync(join(import.meta.dirname, "..", "..", "package.json"), "utf-8"),
) as {
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};

describe("root package manifest", () => {
  it("declares no host-provided package as a runtime dependency", () => {
    const offenders = HOST_PROVIDED.filter((name) => manifest.dependencies?.[name] !== undefined);
    expect(offenders).toEqual([]);
  });

  it("ranges every declared host-provided peer at *", () => {
    const narrow = HOST_PROVIDED.filter(
      (name) => manifest.peerDependencies?.[name] !== undefined && manifest.peerDependencies[name] !== "*",
    );
    expect(narrow).toEqual([]);
  });
});
