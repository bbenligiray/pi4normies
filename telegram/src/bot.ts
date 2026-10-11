import { randomUUID } from "node:crypto";
import { createWriteStream, existsSync } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { autoRetry } from "@grammyjs/auto-retry";
import { sequentialize } from "@grammyjs/runner";
import { Bot, type CallbackQueryContext, type Context, InlineKeyboard } from "grammy";
import type { Config } from "./config.ts";
import { formatDuration, type Job, type Jobs, sanitizeName, UserError } from "./jobs.ts";
import { TRANSCRIBE_MAX_BYTES, transcribe } from "./transcribe.ts";
import type { User, Users } from "./users.ts";

// Telegram handlers. Updates are processed one at a time per chat (see
// main.ts), so e.g. a file and the message after it reach pi in order.

export const HELP = `Hi! I'm your AI assistant. Tell me what you need: research, writing, documents, images, video, small websites, and so on. You can type, send voice messages, or send files.

When I make something for you, I send it here.

Each job gets its own workspace, which removes itself {lifetime} after it starts. Before that, I send you any files you haven't got yet.

/new: start over with a fresh workspace
/status: how much time this workspace has left
/extend: keep it for another {lifetime}
/files: send me every file made so far
/stop: stop what I'm doing
/done: finish and remove the workspace
/model: change the AI model`;

export const COMMANDS = [
	{ command: "new", description: "Start over with a fresh workspace" },
	{ command: "status", description: "How much time this workspace has left" },
	{ command: "extend", description: "Keep the workspace longer" },
	{ command: "files", description: "Send every file made so far" },
	{ command: "stop", description: "Stop what the assistant is doing" },
	{ command: "done", description: "Finish and remove the workspace" },
	{ command: "model", description: "Show or change the AI model" },
	{ command: "help", description: "How this works" },
];

/** After a file arrives, wait this long for more (albums, several files) before telling pi. */
const FILE_BATCH_MS = 1_500;

interface BotContext extends Context {
	user?: User;
}

export type BotType = Bot<BotContext>;

export function createBot(cfg: Config): BotType {
	const bot = new Bot<BotContext>(cfg.botToken, { client: { apiRoot: cfg.apiRoot } });
	// Waits out Telegram's rate limits (429) instead of failing.
	bot.api.config.use(autoRetry({ maxRetryAttempts: 5, maxDelaySeconds: 60 }));
	return bot;
}

export function registerHandlers(bot: BotType, cfg: Config, jobs: Jobs, users: Users): void {
	const lifetime = formatDuration(cfg.lifetimeMs);
	const help = HELP.replace(/\{lifetime\}/g, lifetime);

	// Notes about received files, waiting to go to pi with the next message.
	const pendingNotes = new Map<number, { notes: string[]; timer?: NodeJS.Timeout }>();

	// One update at a time per chat; different users don't wait for each other.
	bot.use(sequentialize((ctx) => ctx.chat?.id.toString()));

	// Private chats only, allowlisted users only.
	bot.use(async (ctx, next) => {
		if (ctx.chat?.type !== "private" || !ctx.from) return;
		const user = users.get(ctx.from.id);
		if (!user) {
			if (ctx.callbackQuery) await ctx.answerCallbackQuery();
			await ctx.reply(
				`Sorry, this assistant is private.\n\nYour Telegram user ID is <code>${ctx.from.id}</code>. To get access, send this number to the person who runs this bot.`,
				{ parse_mode: "HTML" },
			);
			return;
		}
		ctx.user = user;
		await next();
	});

	async function ensureJob(ctx: BotContext): Promise<Job> {
		const userId = ctx.from!.id;
		return jobs.get(userId) ?? (await jobs.start(userId, ctx.user!));
	}

	async function sendToPi(userId: number, text: string): Promise<void> {
		const job = jobs.get(userId);
		if (!job) return;
		try {
			await job.prompt(text);
		} catch (e) {
			const message = e instanceof UserError ? e.message : "Sorry, I couldn't pass that on to the assistant. Please try again.";
			if (!(e instanceof UserError)) console.error(`prompt for ${userId} failed:`, e);
			await bot.api.sendMessage(userId, message).catch(() => undefined);
		}
	}

	function takeNotes(userId: number): string[] {
		const pending = pendingNotes.get(userId);
		if (!pending) return [];
		clearTimeout(pending.timer);
		pendingNotes.delete(userId);
		return pending.notes;
	}

	/** A file arrived: tell pi about it shortly, unless more is coming. */
	function addNote(userId: number, note: string): void {
		const pending = pendingNotes.get(userId) ?? { notes: [] };
		pending.notes.push(note);
		clearTimeout(pending.timer);
		pending.timer = setTimeout(() => {
			const notes = takeNotes(userId);
			if (notes.length) void sendToPi(userId, notes.join("\n"));
		}, FILE_BATCH_MS);
		pendingNotes.set(userId, pending);
	}

	/** Send pi a message from the user, with any file notes waiting before it. */
	async function promptWithNotes(userId: number, text: string): Promise<void> {
		const notes = takeNotes(userId);
		await sendToPi(userId, [...notes, text].join("\n"));
	}

	/**
	 * Get a file the user sent onto local disk. With the local Bot API server,
	 * getFile returns a path on its disk (a volume shared with the bot);
	 * otherwise the file is downloaded over HTTP.
	 */
	async function download(fileId: string): Promise<{ path: string; cleanup: () => Promise<void> }> {
		const file = await bot.api.getFile(fileId);
		if (!file.file_path) throw new Error("Telegram returned no file path");
		if (isAbsolute(file.file_path) && existsSync(file.file_path)) {
			const path = file.file_path;
			// The local server would keep it forever otherwise.
			return { path, cleanup: () => rm(path, { force: true }) };
		}
		const dir = join(cfg.dataDir, "tmp");
		await mkdir(dir, { recursive: true });
		const path = join(dir, randomUUID());
		const response = await fetch(`${cfg.apiRoot}/file/bot${cfg.botToken}/${file.file_path}`);
		if (!response.ok || !response.body) throw new Error(`file download failed: HTTP ${response.status}`);
		await pipeline(Readable.fromWeb(response.body as import("node:stream/web").ReadableStream), createWriteStream(path));
		return { path, cleanup: () => rm(path, { force: true }) };
	}

	/**
	 * Identifies the job a confirmation is about (callback data is limited to
	 * 64 bytes). A button pressed twice, or long after the job it asked about
	 * is gone, must not act on the next job.
	 */
	function jobRef(job: Job): string {
		return job.rec.boxId.slice(0, 12);
	}

	function confirmKeyboard(yes: string, data: string): InlineKeyboard {
		return new InlineKeyboard().text(yes, data).text("Cancel", "cancel");
	}

	// --- commands ---------------------------------------------------------

	bot.command(["start", "help"], (ctx) => ctx.reply(help));

	bot.command("new", async (ctx) => {
		const job = jobs.get(ctx.from!.id);
		if (job) {
			await ctx.reply("Start over? This removes your current workspace. I'll send you any files you haven't got yet first.", {
				reply_markup: confirmKeyboard("Yes, start over", `new:${jobRef(job)}`),
			});
			return;
		}
		await jobs.start(ctx.from!.id, ctx.user!);
	});

	bot.command("done", async (ctx) => {
		const job = jobs.get(ctx.from!.id);
		if (!job) {
			await ctx.reply("There's no workspace running. Send a message any time to start one.");
			return;
		}
		await ctx.reply("Finish this job? I'll send you any files you haven't got yet, then remove the workspace.", {
			reply_markup: confirmKeyboard("Yes, finish", `done:${jobRef(job)}`),
		});
	});

	bot.command("extend", async (ctx) => {
		const job = jobs.get(ctx.from!.id);
		if (!job) {
			await ctx.reply("There's no workspace running. Send a message any time to start one.");
			return;
		}
		job.extend();
		await ctx.reply(`Done. This workspace now removes itself in ${lifetime}.`);
	});

	bot.command("status", async (ctx) => {
		const job = jobs.get(ctx.from!.id);
		if (!job) {
			await ctx.reply("There's no workspace running. Send a message any time to start one.");
			return;
		}
		const lines = [`This workspace removes itself in ${formatDuration(job.rec.expiresAt - Date.now())}.`];
		try {
			const [model, cost] = await Promise.all([job.model(), job.cost()]);
			if (model) lines.push(`AI model: ${model}`);
			if (cost !== undefined) lines.push(`AI cost of this job so far: $${cost.toFixed(2)}`);
		} catch (e) {
			if (!(e instanceof UserError)) throw e;
			lines.push(e.message);
		}
		await ctx.reply(lines.join("\n"));
	});

	bot.command("files", async (ctx) => {
		const job = jobs.get(ctx.from!.id);
		if (!job) {
			await ctx.reply("There's no workspace running, so there are no files.");
			return;
		}
		await job.enqueue(async () => {
			const n = await job.deliverOutputs("all");
			if (n === 0) await job.sendText("No files yet.");
		});
	});

	bot.command("stop", async (ctx) => {
		const job = jobs.get(ctx.from!.id);
		if (!job) {
			await ctx.reply("There's nothing to stop.");
			return;
		}
		takeNotes(ctx.from!.id);
		const stopped = await job.abort();
		await ctx.reply(stopped ? "Stopped. What would you like to do instead?" : "I wasn't working on anything.");
	});

	bot.command("model", async (ctx) => {
		const job = jobs.get(ctx.from!.id);
		const wanted = ctx.match.trim();
		if (!job) {
			await ctx.reply("Start a workspace first (send any message), then choose a model.");
			return;
		}
		if (!wanted) {
			const current = await job.model();
			await ctx.reply(
				`Current AI model: ${current ?? "none"}\n\nTo change it, send /model followed by a model ID from https://openrouter.ai/models, for example:\n/model openai/gpt-6.1-sol`,
				{ link_preview_options: { is_disabled: true } },
			);
			return;
		}
		try {
			const name = await job.setModel(wanted.replace(/^openrouter\//, ""));
			await ctx.reply(`Switched to ${name}.`);
		} catch (e) {
			await ctx.reply(`Couldn't switch to “${wanted}”: ${(e as Error).message}`);
		}
	});

	// --- buttons ----------------------------------------------------------

	bot.callbackQuery("cancel", async (ctx) => {
		await ctx.answerCallbackQuery();
		await ctx.editMessageReplyMarkup().catch(() => undefined);
	});

	/** The job a confirmation button (`<action>:<job ref>`) was about, if it's still the current one. */
	async function confirmedJob(ctx: CallbackQueryContext<BotContext>): Promise<Job | undefined> {
		const job = jobs.get(ctx.from.id);
		const current = job !== undefined && jobRef(job) === ctx.callbackQuery.data.split(":")[1];
		await ctx.answerCallbackQuery(current ? undefined : { text: "That was about a workspace that's already gone." });
		await ctx.editMessageReplyMarkup().catch(() => undefined);
		return current ? job : undefined;
	}

	bot.callbackQuery(/^new:(.+)$/, async (ctx) => {
		const job = await confirmedJob(ctx);
		if (!job) return;
		takeNotes(ctx.from.id);
		await job.finish("new");
		await jobs.start(ctx.from.id, ctx.user!);
	});

	bot.callbackQuery(/^done:(.+)$/, async (ctx) => {
		const job = await confirmedJob(ctx);
		if (!job) return;
		takeNotes(ctx.from.id);
		await job.finish("done");
	});

	bot.callbackQuery("extend", async (ctx) => {
		const job = jobs.get(ctx.from.id);
		if (!job) {
			await ctx.answerCallbackQuery({ text: "That workspace is already gone." });
			return;
		}
		job.extend();
		await ctx.answerCallbackQuery({ text: "Extended" });
		await ctx.editMessageReplyMarkup().catch(() => undefined);
		await ctx.reply(`Done. This workspace now removes itself in ${lifetime}.`);
	});

	bot.callbackQuery(/^ui:(\d+):(\d+)$/, async (ctx) => {
		const choice = jobs.get(ctx.from.id)?.answerUi(ctx.match[1], Number(ctx.match[2]));
		await ctx.answerCallbackQuery(choice ? undefined : { text: "That question has expired." });
		await ctx.editMessageReplyMarkup().catch(() => undefined);
		if (choice) await ctx.reply(`→ ${choice}`);
	});

	// --- messages ---------------------------------------------------------

	bot.on("message:text", async (ctx) => {
		if (ctx.message.text.startsWith("/")) {
			await ctx.reply("I don't know that command. Send /help to see what I can do.");
			return;
		}
		await ensureJob(ctx);
		await promptWithNotes(ctx.from.id, ctx.message.text);
	});

	bot.on("message:voice", async (ctx) => {
		const job = await ensureJob(ctx);
		const voice = ctx.message.voice;
		const file = await download(voice.file_id);
		try {
			let text: string | undefined;
			if ((voice.file_size ?? (await stat(file.path)).size) <= TRANSCRIBE_MAX_BYTES) {
				await ctx.replyWithChatAction("typing");
				try {
					text = await transcribe(file.path, cfg.transcribeModel, ctx.user!.openrouterKey);
				} catch (e) {
					console.warn(`transcription for ${ctx.from.id} failed:`, (e as Error).message);
				}
			}
			if (text) {
				await ctx.reply(`🎤 “${text}”`, { reply_parameters: { message_id: ctx.message.message_id } });
				await promptWithNotes(ctx.from.id, `[Voice message, transcribed automatically]\n${text}`);
			} else {
				const name = sanitizeName(`voice-${new Date().toISOString().slice(0, 19).replace(/:/g, "-")}.ogg`, "voice.ogg");
				const path = await job.addFile(file.path, name);
				await promptWithNotes(ctx.from.id, `[Voice message saved as ${path}; automatic transcription didn't work, please transcribe it yourself]`);
			}
		} finally {
			await file.cleanup();
		}
	});

	// Everything else that carries a file goes into input/.
	bot.on(["message:document", "message:photo", "message:video", "message:audio", "message:video_note", "message:animation"], async (ctx) => {
		const m = ctx.message;
		const stamp = new Date().toISOString().slice(0, 19).replace(/:/g, "-");
		let fileId: string;
		let name: string;
		// Animations also carry a `document`, so they're checked first.
		if (m.photo) {
			fileId = m.photo.at(-1)!.file_id; // the largest size
			name = `photo-${stamp}.jpg`;
		} else if (m.animation) {
			fileId = m.animation.file_id;
			name = sanitizeName(m.animation.file_name, `animation-${stamp}.mp4`);
		} else if (m.video) {
			fileId = m.video.file_id;
			name = sanitizeName(m.video.file_name, `video-${stamp}.mp4`);
		} else if (m.video_note) {
			fileId = m.video_note.file_id;
			name = `video-note-${stamp}.mp4`;
		} else if (m.audio) {
			fileId = m.audio.file_id;
			name = sanitizeName(m.audio.file_name, `audio-${stamp}.mp3`);
		} else if (m.document) {
			fileId = m.document.file_id;
			name = sanitizeName(m.document.file_name, `file-${stamp}`);
		} else {
			return;
		}
		const job = await ensureJob(ctx);
		await ctx.replyWithChatAction("typing");
		const file = await download(fileId);
		let path: string;
		try {
			path = await job.addFile(file.path, name);
		} finally {
			await file.cleanup();
		}
		const note = `[The user sent a file: ${path}]`;
		if (m.caption) await promptWithNotes(ctx.from.id, `${note}\n${m.caption}`);
		else addNote(ctx.from.id, note);
	});

	bot.on("message", (ctx) => ctx.reply("I can't do anything with that kind of message, sorry. Text, voice messages and files work."));

	bot.catch(async (err) => {
		console.error(`update ${err.ctx.update.update_id} failed:`, err.error);
		const chat = err.ctx.chat?.id;
		if (chat === undefined) return;
		const message =
			err.error instanceof UserError ? err.error.message : "Sorry, something went wrong on my side. Please try again in a moment.";
		await bot.api.sendMessage(chat, message).catch(() => undefined);
	});
}
