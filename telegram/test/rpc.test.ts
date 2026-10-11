// PiRpc's framing and lifecycle, on an in-memory stream.
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { PiRpc } from "../src/rpc.ts";

function connect() {
	const stdout = new PassThrough();
	const written: string[] = [];
	const rpc = new PiRpc({ stdout, write: (data) => void written.push(data), detach: () => undefined });
	return { stdout, written, rpc };
}

test("records are split on LF only, and responses are matched to requests by id", async () => {
	const { stdout, written, rpc } = connect();
	const records: unknown[] = [];
	rpc.onRecord((r) => records.push(r));
	const pending = rpc.request({ type: "get_state" }, 1000);
	const { id } = JSON.parse(written[0]);
	// U+2028 inside a string is not a record boundary; a chunk may end mid-record.
	stdout.write(`{"type":"agent_start","note":"a\u2028b"}\r\n{"id":"${id}","type":"response","command":"get_st`);
	stdout.write('ate","success":true,"data":{"isStreaming":false}}\n');
	assert.deepEqual(await pending, { isStreaming: false });
	assert.deepEqual(records, [{ type: "agent_start", note: "a\u2028b" }]);
});

test("a failed response rejects; non-JSON lines are ignored", async () => {
	const { stdout, written, rpc } = connect();
	const pending = rpc.request({ type: "set_model" }, 1000);
	const { id } = JSON.parse(written[0]);
	stdout.write(`stray output\n{"id":"${id}","type":"response","command":"set_model","success":false,"error":"Model not found"}\n`);
	await assert.rejects(pending, /Model not found/);
});

test("after close, nothing is handled and requests are rejected", async () => {
	const { stdout, written, rpc } = connect();
	const records: unknown[] = [];
	let closed = 0;
	rpc.onRecord((r) => records.push(r));
	rpc.onClose(() => closed++);
	const pending = rpc.request({ type: "get_state" }, 1000);
	rpc.close();
	await assert.rejects(pending, /stopped/);
	assert.equal(closed, 1);
	// The stream lives on (the local runtime shares it with the next connection).
	stdout.write('{"type":"agent_start"}\n');
	await new Promise((r) => setImmediate(r));
	assert.deepEqual(records, []);
	assert.equal(stdout.listenerCount("data"), 0);
	await assert.rejects(rpc.request({ type: "get_state" }), /not running/);
	assert.equal(written.length, 1);
	rpc.close(); // idempotent
	assert.equal(closed, 1);
});

test("the stream ending closes the connection", async () => {
	const { stdout, rpc } = connect();
	const pending = rpc.request({ type: "get_state" }, 1000);
	stdout.end();
	await assert.rejects(pending, /stopped/);
	assert.equal(rpc.closed, true);
});
