// Live check with real pi and real OpenRouter calls (costs a few cents), so
// not part of `npm test`. Run with:
//   OPENROUTER_API_KEY=sk-or-... npm run test:live
// It drives the bot through the fake Telegram server, with the local runtime
// running the installed `pi` on a cheap model (LIVE_MODEL), and checks that
// real pi's events come through: an answer, a file it writes, a voice
// message transcribed (TRANSCRIBE_MODEL), and the cost in /status.
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { copyFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { FakeTelegram } from "./fake-telegram.ts";

const KEY = process.env.OPENROUTER_API_KEY;
const MODEL = process.env.LIVE_MODEL ?? "google/gemini-3.5-flash-lite";
const USER = 7;
const data = mkdtempSync(join(tmpdir(), "pi4normies-live-"));
const tg = new FakeTelegram();
let bot: ChildProcess | undefined;

before(async () => {
	if (!KEY) return;
	writeFileSync(join(data, "users.json"), JSON.stringify({ [USER]: { openrouterKey: KEY } }));
	await tg.start();
	bot = spawn(process.execPath, [join(import.meta.dirname, "../src/main.ts")], {
		env: {
			...process.env,
			TELEGRAM_BOT_TOKEN: "42:live",
			TELEGRAM_API_ROOT: tg.url,
			TELEGRAM_CLOUD_LOGOUT: "0",
			RUNTIME: "local",
			LOCAL_PI_COMMAND: `pi --mode rpc --continue --model openrouter/${MODEL}`,
			DATA_DIR: data,
			USERS_FILE: join(data, "users.json"),
		},
		stdio: ["ignore", "inherit", "inherit"],
	});
});

after(async () => {
	bot?.kill("SIGTERM");
	if (KEY) await tg.stop();
});

const skip = !KEY && "OPENROUTER_API_KEY is not set";

test("an answer, and a file it writes", { skip, timeout: 180_000 }, async () => {
	tg.text(USER, "Use your write tool to put a two-line poem about cats into output/poem.txt, then tell me in one short sentence that you did.");
	const doc = await tg.waitFor(USER, (s) => s.method === "sendDocument", 0, 170_000);
	assert.equal(doc.filename, "poem.txt");
	assert.ok(doc.content && doc.content.length > 10);
	const answer = tg.sent.find((s) => s.method === "sendMessage" && s.parse_mode === "HTML");
	assert.ok(answer?.text, "no answer text");
});

test("a voice message is transcribed with the user's key", { skip, timeout: 180_000 }, async () => {
	const from = tg.sent.length;
	const voice = join(data, "voice.oga");
	copyFileSync(join(import.meta.dirname, "fixtures/voice.oga"), voice);
	tg.voice(USER, voice);
	// fixtures/voice.oga says: "Hello, please make me a poster for my cat's birthday party."
	const echo = await tg.waitFor(USER, (s) => /^🎤/.test(s.text ?? ""), from, 60_000);
	assert.match(echo.text!, /poster/i);
	assert.match(echo.text!, /birthday/i);
	await tg.waitFor(USER, (s) => s.method === "sendMessage" && s.parse_mode === "HTML", from, 170_000);
});

test("/status shows the model and a cost", { skip, timeout: 60_000 }, async () => {
	const from = tg.sent.length;
	tg.text(USER, "/status");
	const status = await tg.waitFor(USER, (s) => /removes itself/.test(s.text ?? ""), from);
	assert.ok(status.text!.includes(MODEL), status.text ?? "");
	assert.match(status.text!, /\$\d+\.\d\d/);
});
