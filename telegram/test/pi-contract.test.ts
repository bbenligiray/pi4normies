// What the bot relies on from the real pi (`pi` on PATH; skipped without
// it). No AI calls: everything here works with a dummy key.
//  - RPC mode starts with --continue when there's no session yet.
//  - Stray lines on stdin (attach's request body, empty lines) are rejected
//    without stopping pi or eating the next command.
//  - scripts/pi-telegram keeps stdout for pi's RPC alone.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const hasPi = (() => {
	try {
		execFileSync("pi", ["--version"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
})();
const repo = join(import.meta.dirname, "../..");

/** Feed lines to a command's stdin, keep it open a while, collect stdout lines. */
function run(cmd: string, args: string[], input: string[], opts: { cwd: string; env?: NodeJS.ProcessEnv }): Promise<string[]> {
	return new Promise((resolve, reject) => {
		const child = spawn(cmd, args, { cwd: opts.cwd, env: { ...process.env, OPENROUTER_API_KEY: "dummy", ...opts.env }, stdio: ["pipe", "pipe", "ignore"] });
		let out = "";
		child.stdout.on("data", (d) => {
			out += d;
			// Done once the last command (get_state, id "last") is answered.
			if (out.includes('"id":"last"')) child.stdin.end();
		});
		child.on("error", reject);
		child.on("exit", () => resolve(out.split("\n").filter(Boolean)));
		for (const line of input) child.stdin.write(line);
		setTimeout(() => child.kill(), 60_000);
	});
}

test("pi: --continue without a session, and stray input lines", { skip: !hasPi && "pi is not installed" }, async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-contract-"));
	const lines = await run(
		"pi",
		["--mode", "rpc", "--continue", "--session-dir", join(cwd, "sessions")],
		['{"stream":true,"stdin":true,"stdout":true,"stderr":true,"hijack":true}\n', "\n", '{"id":"last","type":"get_state"}\n'],
		{ cwd },
	);
	const records = lines.map((l) => JSON.parse(l));
	const answer = records.find((r) => r.id === "last");
	assert.equal(answer?.success, true, lines.join("\n"));
	assert.equal(answer.data.isStreaming, false);
	// The stray lines got error responses without an id, which the bot ignores.
	for (const r of records.filter((r) => r.id !== "last")) {
		assert.equal(r.type, "response");
		assert.equal(r.success, false);
	}
});

test("scripts/pi-telegram: only pi on stdout", { skip: !hasPi && "pi is not installed" }, async () => {
	const home = mkdtempSync(join(tmpdir(), "pi-telegram-home-"));
	mkdirSync(join(home, ".pi/agent"), { recursive: true });
	// A post-create that chats on stdout, as the real one does.
	const bin = join(home, "bin");
	mkdirSync(bin);
	writeFileSync(join(bin, "post-create"), '#!/bin/bash\necho "pi 1.0 is up to date."\n');
	chmodSync(join(bin, "post-create"), 0o755);
	const lines = await run(join(repo, "scripts/pi-telegram"), [], ['{"id":"last","type":"get_state"}\n'], {
		cwd: home,
		env: { HOME: home, PATH: `${bin}:${process.env.PATH}`, PI4NORMIES_CONFIG: join(repo, "config") },
	});
	assert.ok(lines.length > 0);
	for (const line of lines) assert.doesNotThrow(() => JSON.parse(line), `not JSON on stdout: ${line}`);
	assert.equal(JSON.parse(lines[0]).id, "last");
	assert.match(readFileSync(join(home, ".pi/agent/AGENTS.md"), "utf8"), /Telegram/);
	assert.ok(existsSync(join(home, "job/input")) && existsSync(join(home, "job/output")));
});
