// A stand-in for `pi --mode rpc`, for the end-to-end test: answers commands
// and plays scripted runs depending on the prompt. Runs in the job directory.
import { mkdirSync, writeFileSync } from "node:fs";

let streaming = false;
let model = "anthropic/claude-opus-5.5";
const messages: unknown[] = [];
let pendingUi: ((value: unknown) => void) | undefined;

function out(record: unknown): void {
	process.stdout.write(`${JSON.stringify(record)}\n`);
}

function assistant(text: string, extra: Record<string, unknown> = {}) {
	const message = { role: "assistant", content: [{ type: "text", text }], stopReason: "stop", ...extra };
	messages.push(message);
	out({ type: "message_start", message: { ...message, content: [], stopReason: "pending" } });
	out({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: text } });
	out({ type: "message_end", message });
}

async function play(prompt: string): Promise<void> {
	streaming = true;
	out({ type: "agent_start" });
	out({ type: "message_end", message: { role: "user", content: [{ type: "text", text: prompt }] } });
	if (prompt.includes("make file")) {
		writeFileSync("output/hello.txt", "hello from pi\n");
		assistant("I made **hello.txt** for you.");
	} else if (prompt.includes("make many")) {
		mkdirSync("output/many", { recursive: true });
		for (let i = 1; i <= 10; i++) writeFileSync(`output/many/file ${i}.txt`, `file ${i}\n`);
		assistant("I made ten files.");
	} else if (prompt.includes("fail")) {
		assistant("", { content: [], stopReason: "error", errorMessage: "402 Insufficient credits" });
	} else if (prompt.includes("ask")) {
		const answer = await new Promise((resolve) => {
			pendingUi = resolve;
			out({ type: "extension_ui_request", id: "ui-1", method: "select", title: "Pick a colour", options: ["Red", "Blue"] });
		});
		assistant(`You chose ${answer}.`);
	} else if (prompt.includes("type something")) {
		const answer = await new Promise((resolve) => {
			pendingUi = resolve;
			out({ type: "extension_ui_request", id: "ui-2", method: "input", title: "What's your name?" });
		});
		assistant(answer === undefined ? "Never mind." : `Hello ${answer}.`);
	} else if (prompt.includes("slow")) {
		await new Promise((r) => setTimeout(r, 3000));
		assistant("Slow answer.");
	} else {
		assistant(`Echo: ${prompt}`);
	}
	streaming = false;
	out({ type: "agent_end", messages: [], willRetry: false });
	out({ type: "agent_settled" });
}

let buffer = "";
process.stdin.on("data", (chunk) => {
	buffer += chunk;
	let nl: number;
	while ((nl = buffer.indexOf("\n")) >= 0) {
		const line = buffer.slice(0, nl);
		buffer = buffer.slice(nl + 1);
		if (!line.trim()) continue;
		// Strict on purpose: anything but our commands on stdin crashes it.
		const cmd = JSON.parse(line);
		const ok = (data?: unknown) => out({ id: cmd.id, type: "response", command: cmd.type, success: true, data });
		switch (cmd.type) {
			case "get_state":
				ok({ isStreaming: streaming, model: { id: model } });
				break;
			case "prompt":
				ok();
				void play(cmd.message);
				break;
			case "get_messages":
				ok({ messages });
				break;
			case "get_session_stats":
				ok({ cost: 0.12 });
				break;
			case "set_model":
				model = cmd.modelId;
				ok({ id: model, name: `Model ${model}` });
				break;
			case "clear_queue":
				ok({ steering: [], followUp: [] });
				break;
			case "abort":
				ok();
				break;
			case "extension_ui_response":
				pendingUi?.(cmd.cancelled ? undefined : cmd.value);
				pendingUi = undefined;
				break;
			default:
				out({ id: cmd.id, type: "response", command: cmd.type, success: false, error: "unsupported" });
		}
	}
});
process.stdin.on("end", () => process.exit(0));
