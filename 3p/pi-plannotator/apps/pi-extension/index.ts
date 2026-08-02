// Preflight loader shim.
//
// The real implementation (plannotator-impl.ts) statically imports ~15 modules from
// ./generated/, which is GITIGNORED and produced ONLY by the pi-pi postinstall vendoring step
// (scripts/postinstall.mjs → vendor.sh / vendorGeneratedNode). If a consumer installs pi-pi with
// lifecycle scripts disabled (`npm install --ignore-scripts`, pnpm's default script blocking,
// sandboxed/allow-scripts CI), postinstall never runs, generated/ is empty, and the static
// imports fail with the opaque "Cannot find module './generated/checklist.js'".
//
// This shim resolves generated/ LAZILY: the preflight below runs before the dynamic import of
// the real implementation, so a missing generated/ produces a clear, actionable error instead.
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const HERE = dirname(fileURLToPath(import.meta.url));

function assertGeneratedPresent(): void {
	const marker = join(HERE, "generated", "checklist.ts");
	if (existsSync(marker)) return;
	throw new Error(
		"pi-plannotator generated sources are missing (3p/pi-plannotator/apps/pi-extension/generated/). " +
			"They are produced by pi-pi's postinstall vendoring step, which was skipped — this usually happens " +
			"when the package is installed with lifecycle scripts disabled (e.g. `npm install --ignore-scripts`, " +
			"pnpm's default script blocking, or sandboxed CI). To fix, run `npm rebuild @ilya-lesikov/pi-pi` " +
			"(or `node scripts/postinstall.mjs`) inside the pi-pi install directory to vendor them.",
	);
}

export default async function plannotator(pi: ExtensionAPI): Promise<void> {
	assertGeneratedPresent();
	const impl = await import("./plannotator-impl.js");
	return impl.default(pi);
}
