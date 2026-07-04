import { afterAll, describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getRepoInfo } from "./project";

const cleanup: string[] = [];

function makeRepo(branch: string): string {
	const dir = mkdtempSync(join(tmpdir(), "plannotator-project-test-"));
	cleanup.push(dir);
	const run = (cmd: string) => execSync(cmd, { cwd: dir, stdio: ["pipe", "pipe", "pipe"] });
	run(`git init -q -b ${branch}`);
	run("git config user.email test@test.local");
	run("git config user.name test");
	run("git remote add origin https://github.com/acme/widget.git");
	run("git commit -q --allow-empty -m init");
	return dir;
}

afterAll(() => {
	for (const dir of cleanup) {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {}
	}
});

describe("getRepoInfo(cwd)", () => {
	test("reports the repo at the given cwd, not process.cwd()", () => {
		const repo = makeRepo("feature-x");
		const info = getRepoInfo(repo);
		expect(info).not.toBeNull();
		expect(info!.display).toBe("acme/widget");
		expect(info!.branch).toBe("feature-x");
	});

	test("two different cwds resolve to their own repos", () => {
		const a = makeRepo("branch-a");
		const b = makeRepo("branch-b");
		expect(getRepoInfo(a)!.branch).toBe("branch-a");
		expect(getRepoInfo(b)!.branch).toBe("branch-b");
	});
});
