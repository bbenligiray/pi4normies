import assert from "node:assert/strict";
import { test } from "node:test";
import { explainError } from "../src/jobs.ts";

test("a request too big for the provider points to /new instead of retrying", () => {
	const err =
		'413 {"type":"error","error":{"type":"invalid_request_error","message":"Downloaded image content cannot exceed 30MB","error_type":"payload_too_large"}}';
	assert.match(explainError(err), /\/new/);
	assert.doesNotMatch(explainError(err), /send your message again/);
	assert.match(explainError("500 internal error"), /send your message again/);
});
