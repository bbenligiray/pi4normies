// DockerRuntime on its own, against the fake Docker Engine API: the calls
// the bot makes on a job container, including reattaching to a running one.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { Config } from "../src/config.ts";
import { PiRpc } from "../src/rpc.ts";
import { FakeDocker } from "./fake-docker.ts";

const docker = new FakeDocker(() => ({ cmd: process.execPath, args: [join(import.meta.dirname, "fake-pi.ts")] }));
const tmp = mkdtempSync(join(tmpdir(), "docker-test-"));
// Only the fields DockerRuntime reads.
const cfg = { image: "img", network: "net", memoryBytes: 1 << 30, cpus: 1, pids: 100, shmBytes: 1 << 20 } as Config;
let runtime: import("../src/docker.ts").DockerRuntime;

before(async () => {
	await docker.start();
	// dockerode reads DOCKER_HOST when it's created.
	process.env.DOCKER_HOST = `unix://${docker.socketPath}`;
	const { DockerRuntime } = await import("../src/docker.ts");
	runtime = new DockerRuntime(cfg);
});

after(() => docker.stop());

test("create, attach, detach, reattach", async () => {
	const box = await runtime.create({ userId: 7, openrouterKey: "k" });
	assert.deepEqual(await box.status(), { exists: true, running: false });

	let rpc = new PiRpc(await box.attach());
	assert.deepEqual(await box.status(), { exists: true, running: true });
	assert.equal(((await rpc.request({ type: "get_state" }, 5000)) as { isStreaming: boolean }).isStreaming, false);

	// Detaching leaves pi running; a fresh handle (as after a bot restart)
	// reattaches. The fake passes attach's request body on to stdin, as Docker
	// may: pi must still get our commands.
	rpc.detach();
	await new Promise((r) => setTimeout(r, 200));
	const again = runtime.open(box.id);
	assert.equal((await again.status()).running, true);
	rpc = new PiRpc(await again.attach());
	assert.ok(await rpc.request({ type: "get_state" }, 5000));
	rpc.detach();
	await again.remove();
});

test("exec, files in and out", async () => {
	const box = await runtime.create({ userId: 7, openrouterKey: "k" });
	const rpc = new PiRpc(await box.attach());
	await rpc.request({ type: "get_state" }, 5000);

	const ls = await box.exec(["ls", "-A", "."]);
	assert.deepEqual(ls, { code: 0, stdout: "input\noutput\n", stderr: "" });
	const fail = await box.exec(["ls", "nope"]);
	assert.notEqual(fail.code, 0);
	assert.match(fail.stderr, /nope/);

	const src = join(tmp, "up.bin");
	const content = Buffer.alloc(300_000, 7);
	writeFileSync(src, content);
	await box.putFile("input", "a b.bin", src);
	const dest = join(tmp, "down.bin");
	await box.getFile("input/a b.bin", dest);
	assert.deepEqual(readFileSync(dest), content);

	await assert.rejects(box.putFile("input", "x/y", src), /Bad file name/);
	await assert.rejects(box.getFile("../etc/passwd", dest), /Bad path/);
	rpc.detach();
	await box.remove();
});

test("list and remove", async () => {
	const a = await runtime.create({ userId: 1, openrouterKey: "k" });
	const b = await runtime.create({ userId: 2, openrouterKey: "k" });
	assert.deepEqual((await runtime.list()).sort(), [a.id, b.id].sort());
	await a.remove();
	await a.remove(); // already gone: fine
	assert.deepEqual(await runtime.list(), [b.id]);
	assert.deepEqual(await a.status(), { exists: false, running: false });
	await b.remove();
});
