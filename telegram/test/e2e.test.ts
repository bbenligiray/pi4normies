// The whole bot against a fake Telegram server and a scripted fake pi (no
// AI calls), once with the local runtime and once with the Docker runtime
// talking to a fake Docker Engine API. Covers the paths a user takes:
// messages, files in and out, dialogs, errors, commands, restarts, expiry
// and ending a job.
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { FakeDocker } from "./fake-docker.ts";
import { FakeTelegram } from "./fake-telegram.ts";

const USER = 1001;
const STRANGER = 2002;
const here = import.meta.dirname;
const fakePi = join(here, "fake-pi.ts");
const hasText = (re: RegExp) => (s: { text?: string }) => re.test(s.text ?? "");

for (const mode of (process.env.E2E_MODES?.split(",") ?? ["local", "docker"]) as Array<"local" | "docker">) {
describe(`with the ${mode} runtime`, () => {
const data = mkdtempSync(join(tmpdir(), "pi4normies-bot-"));
const tg = new FakeTelegram();
const docker = new FakeDocker(() => ({ cmd: process.execPath, args: [fakePi] }));
let bot: ChildProcess | undefined;

function startBot(): void {
	bot = spawn(process.execPath, [join(here, "../src/main.ts")], {
		env: {
			...process.env,
			TELEGRAM_BOT_TOKEN: "42:test",
			TELEGRAM_API_ROOT: tg.url,
			TELEGRAM_CLOUD_LOGOUT: "0",
			RUNTIME: mode,
			LOCAL_PI_COMMAND: `${process.execPath} ${fakePi}`,
			DOCKER_HOST: `unix://${docker.socketPath}`,
			DATA_DIR: data,
			USERS_FILE: join(data, "users.json"),
			// 30 s jobs, warned 15 s before the end, checked every second.
			JOB_LIFETIME_HOURS: String(30 / 3600),
			JOB_WARN_MINUTES: "0.25",
			CHECK_INTERVAL_SECONDS: "1",
		},
		stdio: ["ignore", "inherit", "inherit"],
	});
}

async function stopBot(): Promise<void> {
	if (!bot || bot.exitCode !== null) return;
	const exited = new Promise((r) => bot!.once("exit", r));
	bot.kill("SIGTERM");
	await exited;
}

/** The job directories (the one with input/ and output/) that exist. */
function jobDirs(): string[] {
	if (mode === "docker") return [...docker.containers.values()].map((c) => join(c.home, "job"));
	const root = join(data, "local-jobs");
	return existsSync(root) ? readdirSync(root).map((id) => join(root, id)) : [];
}

before(async () => {
	writeFileSync(join(data, "users.json"), JSON.stringify({ [USER]: { name: "Test", openrouterKey: "sk-or-test" } }));
	await tg.start();
	await docker.start();
	startBot();
});

after(async () => {
	await stopBot();
	await tg.stop();
	await docker.stop();
});

test("a stranger is told their user ID", async () => {
	tg.text(STRANGER, "hi");
	const reply = await tg.waitFor(STRANGER, hasText(/private/));
	assert.match(reply.text!, /<code>2002<\/code>/);
	assert.equal(jobDirs().length, 0);
});

test("the first message starts a workspace and gets an answer", async () => {
	const from = tg.sent.length;
	tg.text(USER, "hello <there>");
	await tg.waitFor(USER, hasText(/Setting up/), from);
	await tg.waitFor(USER, hasText(/workspace is ready/), from);
	const answer = await tg.waitFor(USER, hasText(/Echo/), from);
	assert.equal(answer.text, "Echo: hello &lt;there&gt;");
	assert.equal(answer.parse_mode, "HTML");
	assert.equal(jobDirs().length, 1);
});

test("files the assistant makes are sent", async () => {
	const from = tg.sent.length;
	tg.text(USER, "please make file");
	const answer = await tg.waitFor(USER, hasText(/I made/), from);
	assert.equal(answer.text, "I made <b>hello.txt</b> for you.");
	const doc = await tg.waitFor(USER, (s) => s.method === "sendDocument", from);
	assert.equal(doc.filename, "hello.txt");
	assert.equal(doc.content?.toString(), "hello from pi\n");
	// Not sent again after the next answer.
	const from2 = tg.sent.length;
	tg.text(USER, "thanks");
	await tg.waitFor(USER, hasText(/Echo: thanks/), from2);
	await new Promise((r) => setTimeout(r, 500));
	assert.equal(tg.sent.slice(from2).filter((s) => s.method === "sendDocument").length, 0);
});

test("many files come as one zip", async () => {
	const from = tg.sent.length;
	tg.text(USER, "make many");
	const doc = await tg.waitFor(USER, (s) => s.method === "sendDocument", from);
	assert.equal(doc.filename, "files.zip");
	assert.equal(doc.caption, "10 files");
	const zipPath = join(data, "check.zip");
	writeFileSync(zipPath, doc.content!);
	const { execFileSync } = await import("node:child_process");
	const listing = execFileSync("unzip", ["-Z1", zipPath]).toString();
	assert.match(listing, /^many\/file 1\.txt$/m);
	assert.equal(listing.trim().split("\n").length, 10);
});

test("a file from the user lands in input/ and pi hears about it", async () => {
	const src = join(data, "upload.pdf");
	writeFileSync(src, "%PDF fake");
	const from = tg.sent.length;
	tg.document(USER, src, "../../Report: Q3.pdf", "what is this?");
	const answer = await tg.waitFor(USER, hasText(/Echo/), from);
	assert.match(answer.text!, /\[The user sent a file: input\/Report: Q3\.pdf\]\nwhat is this\?/);
	const dir = jobDirs()[0];
	assert.equal(readFileSync(join(dir, "input", "Report: Q3.pdf"), "utf8"), "%PDF fake");
	// The local Bot API server's copy is cleaned up.
	assert.equal(existsSync(src), false);

	// Same name again: kept apart. Without a caption, the note waits briefly and goes alone.
	writeFileSync(src, "second");
	const from2 = tg.sent.length;
	tg.document(USER, src, "Report: Q3.pdf");
	const second = await tg.waitFor(USER, hasText(/Echo/), from2);
	assert.match(second.text!, /input\/Report: Q3 \(2\)\.pdf/);
});

test("a voice message that can't be transcribed is saved for the assistant", async () => {
	const src = join(data, "voice.oga");
	writeFileSync(src, "not really audio");
	const from = tg.sent.length;
	tg.voice(USER, src);
	const answer = await tg.waitFor(USER, hasText(/Echo/), from, 30_000);
	assert.match(answer.text!, /Voice message saved as input\/voice-.*\.ogg/);
});

test("model errors are explained", async () => {
	const from = tg.sent.length;
	tg.text(USER, "fail please");
	await tg.waitFor(USER, hasText(/out of credit/), from);
});

test("extension dialogs become buttons", async () => {
	const from = tg.sent.length;
	tg.text(USER, "ask me");
	const question = await tg.waitFor(USER, hasText(/Pick a colour/), from);
	const buttons = question.reply_markup!.inline_keyboard!.flat();
	assert.deepEqual(
		buttons.map((b) => b.text),
		["Red", "Blue"],
	);
	tg.press(USER, buttons[1].callback_data);
	await tg.waitFor(USER, hasText(/You chose Blue/), from);
});

test("a free-text question takes the next message as its answer, unless /stop dismissed it", async () => {
	let from = tg.sent.length;
	tg.text(USER, "please type something");
	await tg.waitFor(USER, hasText(/What's your name\?/), from);
	tg.text(USER, "Ayşe");
	await tg.waitFor(USER, hasText(/Hello Ayşe\./), from);

	// Left unanswered and stopped: the next message must be a prompt again,
	// not swallowed as the answer to a question nobody is asking anymore.
	from = tg.sent.length;
	tg.text(USER, "please type something");
	await tg.waitFor(USER, hasText(/What's your name\?/), from);
	tg.text(USER, "/stop");
	await tg.waitFor(USER, hasText(/Never mind\./), from);
	await tg.waitFor(USER, hasText(/^Stopped\./), from);
	from = tg.sent.length;
	tg.text(USER, "hello again");
	await tg.waitFor(USER, hasText(/Echo: hello again/), from);
});

test("commands: status, model, files, unknown", async () => {
	let from = tg.sent.length;
	tg.text(USER, "/status");
	const status = await tg.waitFor(USER, hasText(/removes itself in/), from);
	assert.match(status.text!, /claude-opus-5\.5/);
	assert.match(status.text!, /\$0\.12/);

	from = tg.sent.length;
	tg.text(USER, "/model openrouter/openai/gpt-6.1-sol");
	await tg.waitFor(USER, hasText(/Switched to Model openai\/gpt-6\.1-sol/), from);

	from = tg.sent.length;
	tg.text(USER, "/files");
	await tg.waitFor(USER, (s) => s.filename === "files.zip", from);

	from = tg.sent.length;
	tg.text(USER, "/nonsense");
	await tg.waitFor(USER, hasText(/don't know that command/), from);
});

test("/new asks first; its button acts only on the job it asked about", async () => {
	let from = tg.sent.length;
	tg.text(USER, "/new");
	const confirm = await tg.waitFor(USER, hasText(/Start over\?/), from);
	const button = confirm.reply_markup!.inline_keyboard![0][0].callback_data;
	tg.press(USER, button);
	await tg.waitFor(USER, hasText(/removed itself.*Starting a fresh one/), from);
	await tg.waitFor(USER, hasText(/workspace is ready/), from);
	assert.equal(jobDirs().length, 1);

	// Tapped again (a double tap, or a stale button found later in the
	// chat): the new workspace stays.
	from = tg.sent.length;
	tg.press(USER, button);
	tg.text(USER, "still here?");
	await tg.waitFor(USER, hasText(/Echo: still here\?/), from);
	assert.equal(tg.sent.slice(from).filter(hasText(/removed itself|Setting up/)).length, 0);
	assert.equal(jobDirs().length, 1);
});

test("a bot restart keeps the job", async () => {
	await stopBot();
	assert.equal(jobDirs().length, 1);
	startBot();
	const from = tg.sent.length;
	tg.text(USER, "still there?");
	await tg.waitFor(USER, hasText(/Echo: still there\?/), from);
	assert.equal(tg.sent.slice(from).filter(hasText(/Setting up/)).length, 0);
});

test("a run cut short by a restart is reported", async () => {
	const from = tg.sent.length;
	tg.text(USER, "slow one");
	await new Promise((r) => setTimeout(r, 800));
	// pi dies while the bot is down. (The local runtime's pi dies with the
	// bot anyway; a container's pi has to be crashed.)
	await stopBot();
	if (mode === "docker") docker.crash([...docker.containers.keys()][0]);
	startBot();
	await tg.waitFor(USER, hasText(/I was interrupted/), from);
	const from2 = tg.sent.length;
	tg.text(USER, "again");
	await tg.waitFor(USER, hasText(/Echo: again/), from2);
});

if (mode === "docker") {
	test("pi crashing while the bot runs: reconnects to the restarted container", async () => {
		docker.crash([...docker.containers.keys()][0]);
		await new Promise((r) => setTimeout(r, 4500));
		const from = tg.sent.length;
		tg.text(USER, "back?");
		await tg.waitFor(USER, hasText(/Echo: back\?/), from);
	});

	test("the job container is labelled, limited and keyed", async () => {
		const c = [...docker.containers.values()][0];
		assert.equal(c.labels["pi4normies.job"], "1");
		assert.equal(c.labels["pi4normies.user"], String(USER));
		assert.ok(c.env.includes("OPENROUTER_API_KEY=sk-or-test"));
		assert.match(c.name, /^pi4normies-1001-/);
	});
}

test("/done sends unsent files, then removes the workspace", async () => {
	// Let the last answer's file check finish first.
	await new Promise((r) => setTimeout(r, 500));
	const dir = jobDirs()[0];
	writeFileSync(join(dir, "output", "late.txt"), "late");
	const from = tg.sent.length;
	tg.text(USER, "/done");
	const confirm = await tg.waitFor(USER, hasText(/Finish this job/), from);
	tg.press(USER, confirm.reply_markup!.inline_keyboard![0][0].callback_data);
	const late = await tg.waitFor(USER, (s) => s.method === "sendDocument", from);
	assert.equal(late.filename, "late.txt");
	await tg.waitFor(USER, hasText(/All done.*Its files are above/), from);
	assert.equal(jobDirs().length, 0);
});

test("/done says so when every file was already sent", async () => {
	let from = tg.sent.length;
	tg.text(USER, "please make file");
	await tg.waitFor(USER, (s) => s.method === "sendDocument", from);
	from = tg.sent.length;
	tg.text(USER, "/done");
	const confirm = await tg.waitFor(USER, hasText(/Finish this job/), from);
	tg.press(USER, confirm.reply_markup!.inline_keyboard![0][0].callback_data);
	await tg.waitFor(USER, hasText(/All done.*already received all its files/), from);
	assert.equal(tg.sent.slice(from).filter((s) => s.method === "sendDocument").length, 0);
	assert.equal(jobDirs().length, 0);
});

test("a job warns before expiring, then removes itself", { timeout: 60_000 }, async () => {
	let from = tg.sent.length;
	tg.text(USER, "new job");
	await tg.waitFor(USER, hasText(/Echo: new job/), from);

	from = tg.sent.length;
	const warning = await tg.waitFor(USER, hasText(/removes itself in about/), from, 30_000);
	assert.equal(warning.reply_markup!.inline_keyboard![0][0].callback_data, "extend");
	// Extending pushes the end out by a full lifetime (30 s here)...
	tg.press(USER, "extend");
	await tg.waitFor(USER, hasText(/now removes itself in/), from);
	const extendedAt = Date.now();
	// ...so it warns again and expires about 30 s after the extension.
	from = tg.sent.length;
	await tg.waitFor(USER, hasText(/removes itself in about/), from, 30_000);
	const farewell = await tg.waitFor(USER, hasText(/reached the end of its time/), from, 30_000);
	// It made no files, so there's nothing to say about them.
	assert.doesNotMatch(farewell.text!, /files/);
	assert.ok(Date.now() - extendedAt >= 28_000);
	assert.equal(jobDirs().length, 0);
});
});
}
