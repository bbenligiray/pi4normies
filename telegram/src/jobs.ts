import { randomUUID } from "node:crypto";
import { mkdir, rm, stat } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { type Api, GrammyError, InlineKeyboard, InputFile } from "grammy";
import type { Config } from "./config.ts";
import { renderMarkdown } from "./render.ts";
import { PiRpc, type RpcRecord } from "./rpc.ts";
import type { Box, Runtime } from "./runtime.ts";
import type { JobRecord, State } from "./state.ts";
import type { User } from "./users.ts";

// A job is one user's workspace: a Box running pi, plus the bridge between
// pi's RPC events and the user's Telegram chat. Each user has at most one job.
// It lives until it expires (24 hours after it started, unless extended),
// the user ends it, or they start a new one; then the files it made that
// weren't sent yet are sent, and it's removed.

/** The local Bot API server accepts uploads up to 2000 MB. */
export const TELEGRAM_MAX_UPLOAD = 2000 * 1024 * 1024;
/** More new files than this after one answer are sent as a single zip. */
const MAX_SEPARATE_FILES = 8;
const READY_TIMEOUT_MS = 6 * 60_000;
const RECONNECT_DELAY_MS = 3_000;
const RECONNECT_RETRY_MS = 15_000;
const RECONNECT_ATTEMPTS = 40;

export type FinishReason = "done" | "expired" | "new";

interface OutFile {
	path: string;
	size: number;
	mtime: string;
}

interface UiRequest {
	id: string;
	method: "confirm" | "select";
	options: string[];
}

interface AssistantMessage {
	role: string;
	content?: Array<{ type: string; text?: string }>;
	stopReason?: string;
	errorMessage?: string;
}

function assistantText(message: AssistantMessage): string {
	return (message.content ?? [])
		.filter((c) => c.type === "text" && c.text)
		.map((c) => c.text!.trim())
		.filter(Boolean)
		.join("\n\n");
}

/** What a failed model call means for the user. */
export function explainError(message: string): string {
	if (/\b401\b|unauthori[sz]ed|invalid.{0,20}key|no auth|user not found/i.test(message)) {
		return "The AI service didn't accept the key set up for you. Please let the person who runs this bot know.";
	}
	if (/\b402\b|credit|insufficient|payment required/i.test(message)) {
		return "Your OpenRouter account is out of credit. Add some at https://openrouter.ai/settings/credits, then send your message again.";
	}
	if (/\b429\b|rate.?limit|overloaded|\b529\b/i.test(message)) {
		return "The AI service is very busy right now. Please wait a minute and send your message again.";
	}
	if (/\b413\b|payload.?too.?large|image content cannot exceed|too many images/i.test(message)) {
		return "Our conversation has grown too big for the AI service (usually from lots of images or screenshots), so sending again won't help. Send /new to start over with a fresh workspace; I'll send you the files made so far first.";
	}
	return `Something went wrong on the AI service's side. Please send your message again in a moment.\n\n(Details: ${message.slice(0, 300)})`;
}

export function formatDuration(ms: number): string {
	const minutes = Math.max(0, Math.round(ms / 60_000));
	const h = Math.floor(minutes / 60);
	const m = minutes % 60;
	if (h === 0) return `${m} minute${m === 1 ? "" : "s"}`;
	return m === 0 ? `${h} hour${h === 1 ? "" : "s"}` : `${h} h ${m} min`;
}

/** A safe, readable file name for input/. */
export function sanitizeName(name: string | undefined, fallback: string): string {
	let n = basename((name ?? "").replace(/\\/g, "/"))
		.replace(/[\u0000-\u001f\u007f/]/g, "")
		.trim();
	if (!n || n === "." || n === "..") n = fallback;
	if (n.startsWith("-") || n.startsWith(".")) n = `file${n}`;
	if (n.length > 120) {
		const ext = extname(n).slice(0, 20);
		n = n.slice(0, 120 - ext.length) + ext;
	}
	return n;
}

/** `name`, or `name (2).ext` etc. if taken. */
export function uniqueName(name: string, taken: Set<string>): string {
	if (!taken.has(name)) return name;
	const ext = extname(name);
	const stem = name.slice(0, name.length - ext.length);
	for (let i = 2; ; i++) {
		const candidate = `${stem} (${i})${ext}`;
		if (!taken.has(candidate)) return candidate;
	}
}

export class Job {
	rec: JobRecord;
	readonly box: Box;
	private readonly jobs: Jobs;
	private rpc?: PiRpc;
	private chain: Promise<void> = Promise.resolve();
	private typing?: NodeJS.Timeout;
	private readonly ui = new Map<string, UiRequest>();
	private uiSeq = 0;
	/** An extension asked for free text; the user's next message answers it. */
	private awaitingInput?: string;
	/** The last model error of the current run, reported once it has settled. */
	private lastError?: string;
	private reconnectTimer?: NodeJS.Timeout;
	finishing = false;

	constructor(jobs: Jobs, rec: JobRecord, box: Box) {
		this.jobs = jobs;
		this.rec = rec;
		this.box = box;
	}

	get chatId(): number {
		return this.rec.userId;
	}

	private get api(): Api {
		return this.jobs.api;
	}

	/** Run `fn` after everything queued before it, so messages stay in order. */
	enqueue(fn: () => Promise<unknown>): Promise<void> {
		const next = this.chain.then(fn).then(
			() => undefined,
			(e) => console.error(`job ${this.rec.boxId}:`, e),
		);
		this.chain = next;
		return next;
	}

	private save(): void {
		this.jobs.state.setJob(this.rec);
	}

	// --- pi connection ---------------------------------------------------

	/** Attach to pi and wait until it answers. Returns its state. */
	async connect(): Promise<{ isStreaming: boolean }> {
		const io = await this.box.attach();
		const rpc = new PiRpc(io);
		rpc.onRecord((record) => this.onRecord(record));
		rpc.onClose(() => this.onClosed(rpc));
		try {
			const state = await rpc.request<{ isStreaming: boolean }>({ type: "get_state" }, READY_TIMEOUT_MS);
			if (this.finishing) throw new Error("job finished while connecting");
			// Only now is it in use: messages from the user wait for this.
			this.rpc = rpc;
			return state;
		} catch (e) {
			rpc.detach();
			throw e;
		}
	}

	private onClosed(rpc: PiRpc): void {
		if (rpc !== this.rpc) return;
		this.rpc = undefined;
		this.setBusy(false, false);
		// Whatever pi was asking can't be answered over this connection anymore.
		this.clearDialogs();
		if (this.finishing) return;
		console.warn(`job ${this.rec.boxId}: lost the connection to pi, reconnecting`);
		this.scheduleReconnect(RECONNECT_DELAY_MS, 1);
	}

	private scheduleReconnect(delay: number, attempt: number): void {
		clearTimeout(this.reconnectTimer);
		this.reconnectTimer = setTimeout(() => void this.reconnect(attempt), delay);
	}

	/** (Re)connect to a job that was already running: after a bot restart, or pi restarting. */
	async reconnect(attempt = 1): Promise<void> {
		if (this.finishing || this.rpc) return;
		try {
			const status = await this.box.status();
			if (!status.exists) {
				await this.jobs.lost(this, "Your workspace disappeared unexpectedly, so its files are gone. Sorry! Send a message to start a new one.");
				return;
			}
			const state = await this.connect();
			if (state.isStreaming) {
				this.setBusy(true);
			} else if (this.rec.busy) {
				// The run ended while we weren't listening: either it finished, or
				// pi was restarted in the middle of it.
				await this.reportMissedRun();
			}
		} catch (e) {
			if (this.finishing) return;
			console.warn(`job ${this.rec.boxId}: reconnect attempt ${attempt} failed:`, (e as Error).message);
			if (attempt < RECONNECT_ATTEMPTS) {
				this.scheduleReconnect(RECONNECT_RETRY_MS, attempt + 1);
			} else {
				await this.jobs.lost(this, "Your workspace stopped working and couldn't be restarted, sorry. Send a message to start a new one.");
			}
		}
	}

	private async reportMissedRun(): Promise<void> {
		const data = await this.rpc!.request<{ messages: AssistantMessage[] }>({ type: "get_messages" });
		const last = data.messages.at(-1);
		this.rec.busy = false;
		this.save();
		const text = last?.role === "assistant" && last.stopReason === "stop" ? assistantText(last) : "";
		if (text) {
			this.enqueue(() => this.sendMarkdown(text));
		} else {
			this.enqueue(() =>
				this.sendText(
					"Sorry, I was interrupted (the server restarted) and didn't finish. Our conversation is kept: please send your last message again.",
				),
			);
		}
		this.enqueue(() => this.deliverOutputs("new"));
	}

	private onRecord(record: RpcRecord): void {
		switch (record.type) {
			case "agent_start":
				this.setBusy(true);
				break;
			case "message_end": {
				const message = record.message as AssistantMessage;
				if (message?.role !== "assistant") break;
				if (message.stopReason === "error") {
					this.lastError = message.errorMessage ?? "unknown error";
					break;
				}
				this.lastError = undefined;
				const text = assistantText(message);
				if (text) this.enqueue(() => this.sendMarkdown(text));
				break;
			}
			case "agent_settled": {
				this.setBusy(false);
				// Dialogs belong to the run; pi has resolved any still open ones
				// (e.g. by timeout), so the user's next message must be a prompt.
				this.clearDialogs();
				const error = this.lastError;
				this.lastError = undefined;
				if (error) this.enqueue(() => this.sendText(explainError(error)));
				this.enqueue(() => this.deliverOutputs("new"));
				break;
			}
			case "extension_ui_request":
				this.onUiRequest(record);
				break;
			case "extension_error":
				console.warn(`job ${this.rec.boxId}: extension error:`, record.extensionPath, record.event, record.error);
				break;
		}
	}

	private setBusy(busy: boolean, persist = true): void {
		if (persist && this.rec.busy !== busy) {
			this.rec.busy = busy;
			this.save();
		}
		if (busy && !this.typing) {
			const tick = () => void this.api.sendChatAction(this.chatId, "typing").catch(() => undefined);
			tick();
			this.typing = setInterval(tick, 4_500);
		} else if (!busy && this.typing) {
			clearInterval(this.typing);
			this.typing = undefined;
		}
	}

	/** pi's connection, waiting for it while (re)connecting. */
	private async requireRpc(timeoutMs = 120_000): Promise<PiRpc> {
		const deadline = Date.now() + timeoutMs;
		while (!this.rpc) {
			if (this.finishing) throw new UserError("This workspace has just been removed. Send your message again to start a new one.");
			if (Date.now() > deadline) throw new UserError("The assistant is restarting. Please try again in a minute.");
			await new Promise((r) => setTimeout(r, 250));
		}
		return this.rpc;
	}

	// --- from the user ---------------------------------------------------

	/** A message for pi: starts a run, or steers the one in progress. */
	async prompt(text: string): Promise<void> {
		const rpc = await this.requireRpc();
		if (this.awaitingInput) {
			rpc.send({ type: "extension_ui_response", id: this.awaitingInput, value: text });
			this.awaitingInput = undefined;
			return;
		}
		void this.api.sendChatAction(this.chatId, "typing").catch(() => undefined);
		await rpc.request({ type: "prompt", message: text, streamingBehavior: "steer" }, 120_000);
	}

	async abort(): Promise<boolean> {
		const rpc = await this.requireRpc();
		const state = await rpc.request<{ isStreaming: boolean }>({ type: "get_state" });
		if (!state.isStreaming) return false;
		// A dialog blocks the tool call that's being aborted; dismiss it first.
		this.cancelDialogs(rpc);
		await rpc.request({ type: "clear_queue" });
		await rpc.request({ type: "abort" }, 60_000);
		return true;
	}

	async model(): Promise<string | undefined> {
		const state = await (await this.requireRpc(10_000)).request<{ model?: { id: string } }>({ type: "get_state" });
		return state.model?.id;
	}

	async setModel(modelId: string): Promise<string> {
		const model = await (await this.requireRpc()).request<{ id: string; name?: string }>({
			type: "set_model",
			provider: "openrouter",
			modelId,
		});
		return model.name ?? model.id;
	}

	async cost(): Promise<number | undefined> {
		const stats = await (await this.requireRpc(10_000)).request<{ cost?: number }>({ type: "get_session_stats" });
		return stats.cost;
	}

	/** Copy a file the user sent into input/. Returns its path for pi. */
	async addFile(localPath: string, name: string): Promise<string> {
		const listing = await this.box.exec(["ls", "-A", "input"]);
		const taken = new Set(listing.stdout.split("\n").filter(Boolean));
		const finalName = uniqueName(name, taken);
		await this.box.putFile("input", finalName, localPath);
		return `input/${finalName}`;
	}

	extend(): void {
		this.rec.expiresAt = Date.now() + this.jobs.cfg.lifetimeMs;
		this.rec.warned = false;
		this.save();
	}

	// --- extension dialogs ----------------------------------------------

	private onUiRequest(record: RpcRecord): void {
		const id = String(record.id);
		const title = String(record.title ?? "");
		switch (record.method) {
			case "notify": {
				const prefix = record.notifyType === "error" || record.notifyType === "warning" ? "⚠️ " : "";
				this.enqueue(() => this.sendText(`${prefix}${record.message}`));
				break;
			}
			case "confirm":
			case "select": {
				const options = record.method === "confirm" ? ["Yes", "No"] : ((record.options as string[]) ?? []).slice(0, 20);
				const key = String(++this.uiSeq);
				this.ui.set(key, { id, method: record.method, options });
				// With a timeout, pi answers for the user when it runs out.
				if (typeof record.timeout === "number") setTimeout(() => this.ui.delete(key), record.timeout);
				const keyboard = new InlineKeyboard();
				options.forEach((option, i) => keyboard.text(option.slice(0, 60), `ui:${key}:${i}`).row());
				const text = [title, record.message].filter(Boolean).join("\n\n") || "Please choose:";
				this.enqueue(() => this.api.sendMessage(this.chatId, text, { reply_markup: keyboard }));
				break;
			}
			case "input":
			case "editor": {
				this.awaitingInput = id;
				if (typeof record.timeout === "number") {
					setTimeout(() => {
						if (this.awaitingInput === id) this.awaitingInput = undefined;
					}, record.timeout);
				}
				const hint = record.prefill ? `\n\n${record.prefill}` : record.placeholder ? ` (e.g. ${record.placeholder})` : "";
				this.enqueue(() => this.sendText(`${title || "I need a short answer from you."}${hint}\n\nJust reply with your answer.`));
				break;
			}
		}
	}

	/** Forget the dialogs waiting for the user (pi is no longer waiting for them). */
	private clearDialogs(): void {
		this.ui.clear();
		this.awaitingInput = undefined;
	}

	/** Dismiss the dialogs waiting for the user, telling pi so. */
	private cancelDialogs(rpc: PiRpc): void {
		const ids = [...this.ui.values()].map((request) => request.id);
		if (this.awaitingInput) ids.push(this.awaitingInput);
		for (const id of ids) rpc.send({ type: "extension_ui_response", id, cancelled: true });
		this.clearDialogs();
	}

	/** A button of an extension dialog was pressed. Returns the chosen label. */
	answerUi(key: string, index: number): string | undefined {
		const request = this.ui.get(key);
		if (!request || !this.rpc) return undefined;
		this.ui.delete(key);
		const choice = request.options[index];
		if (choice === undefined) return undefined;
		if (request.method === "confirm") this.rpc.send({ type: "extension_ui_response", id: request.id, confirmed: index === 0 });
		else this.rpc.send({ type: "extension_ui_response", id: request.id, value: choice });
		return choice;
	}

	// --- to the user -----------------------------------------------------

	async sendText(text: string): Promise<void> {
		await this.api.sendMessage(this.chatId, text, { link_preview_options: { is_disabled: true } });
	}

	async sendMarkdown(markdown: string): Promise<void> {
		for (const chunk of renderMarkdown(markdown)) {
			try {
				await this.api.sendMessage(this.chatId, chunk.html, {
					parse_mode: "HTML",
					link_preview_options: { is_disabled: true },
				});
			} catch (e) {
				if (!(e instanceof GrammyError) || e.error_code !== 400) throw e;
				// Telegram didn't like the HTML after all; send it as it was written.
				await this.api.sendMessage(this.chatId, chunk.plain.slice(0, 4096), { link_preview_options: { is_disabled: true } });
			}
		}
	}

	async listOutputs(): Promise<OutFile[]> {
		// NUL-separated, so any file name works. Hidden files and folders are skipped.
		const r = await this.box.exec(["find", "output", "-type", "f", "-not", "-path", "*/.*", "-printf", "%s %T@ %P\\0"]);
		if (r.code !== 0) throw new Error(`listing output/ failed: ${r.stderr.trim()}`);
		return r.stdout
			.split("\0")
			.filter(Boolean)
			.map((line) => {
				const [size, mtime, ...rest] = line.split(" ");
				return { path: rest.join(" "), size: Number(size), mtime };
			})
			.sort((a, b) => a.path.localeCompare(b.path));
	}

	/**
	 * Send files from output/: "new" ones not sent yet (or changed since), or
	 * "all". Returns how many were sent.
	 */
	async deliverOutputs(which: "new" | "all"): Promise<number> {
		const files = await this.listOutputs();
		const signature = (f: OutFile) => `${f.size}:${f.mtime}`;
		const picked = files.filter((f) => f.size > 0 && (which === "all" || this.rec.sent[f.path] !== signature(f)));
		if (picked.length === 0) return 0;
		void this.api.sendChatAction(this.chatId, "upload_document").catch(() => undefined);
		if (picked.length > MAX_SEPARATE_FILES) {
			await this.sendZip(picked);
		} else {
			for (const f of picked) await this.sendFile(f);
		}
		for (const f of picked) this.rec.sent[f.path] = signature(f);
		this.save();
		return picked.length;
	}

	private async withTemp<T>(fn: (path: string) => Promise<T>): Promise<T> {
		const dir = join(this.jobs.cfg.dataDir, "tmp");
		await mkdir(dir, { recursive: true });
		const path = join(dir, randomUUID());
		try {
			return await fn(path);
		} finally {
			await rm(path, { force: true });
		}
	}

	private async sendFile(f: OutFile): Promise<void> {
		if (f.size > TELEGRAM_MAX_UPLOAD) {
			await this.sendText(
				`“${f.path}” is too big to send over Telegram (${(f.size / 1024 ** 3).toFixed(1)} GB, the limit is 2 GB). Ask me to make it smaller or split it into parts.`,
			);
			return;
		}
		await this.withTemp(async (tmp) => {
			await this.box.getFile(`output/${f.path}`, tmp);
			await this.api.sendDocument(this.chatId, new InputFile(tmp, basename(f.path)), {
				caption: f.path.includes("/") ? f.path : undefined,
			});
		});
	}

	private async sendZip(files: OutFile[]): Promise<void> {
		const zip = ".send/files.zip";
		const r = await this.box.exec(
			[
				"sh",
				"-c",
				'rm -rf .send && mkdir .send && cd output && exec zip -q -X "../$0" -- "$@"',
				zip,
				...files.map((f) => `./${f.path}`),
			],
			30 * 60_000,
		);
		if (r.code !== 0) throw new Error(`zip failed: ${r.stderr.trim()}`);
		try {
			await this.withTemp(async (tmp) => {
				await this.box.getFile(zip, tmp);
				const { size } = await stat(tmp);
				if (size > TELEGRAM_MAX_UPLOAD) {
					await this.sendText(
						`I made ${files.length} files, but together they're too big to send over Telegram (the limit is 2 GB). Ask me to send them in smaller groups.`,
					);
					return;
				}
				await this.api.sendDocument(this.chatId, new InputFile(tmp, "files.zip"), {
					caption: `${files.length} files`,
				});
			});
		} finally {
			await this.box.exec(["rm", "-rf", ".send"]).catch(() => undefined);
		}
	}

	// --- the end ---------------------------------------------------------

	/** Send what's left in output/, then remove the workspace. */
	async finish(reason: FinishReason): Promise<void> {
		if (this.finishing) return;
		this.finishing = true;
		clearTimeout(this.reconnectTimer);
		this.setBusy(false, false);
		await this.chain;
		let sent = 0;
		let failed = false;
		try {
			// Listing output/ needs a running container; without one, its files
			// can't be collected (and the user should know).
			if (!(await this.box.status()).running) throw new Error("the container isn't running");
			sent = await this.deliverOutputs("new");
		} catch (e) {
			failed = true;
			console.error(`job ${this.rec.boxId}: sending the last files failed:`, e);
		}
		const files = failed
			? " I couldn't collect its last files, sorry."
			: sent > 0
				? " Its files are above."
				: Object.keys(this.rec.sent).length > 0
					? " You've already received all its files."
					: "";
		const text = {
			done: `✅ All done. This workspace has removed itself.${files} Send a message any time to start a new job.`,
			expired: `⏳ This workspace reached the end of its time and has removed itself.${files} Send a message any time to start a new job.`,
			new: `This workspace has removed itself.${files} Starting a fresh one…`,
		}[reason];
		await this.dispose();
		await this.sendText(text).catch((e) => console.error("farewell failed:", e));
	}

	/** Disconnect and delete the box and its record (no messages). */
	async dispose(): Promise<void> {
		this.finishing = true;
		clearTimeout(this.reconnectTimer);
		this.setBusy(false, false);
		this.rpc?.detach();
		this.rpc = undefined;
		await this.box.remove().catch((e) => console.error(`removing ${this.rec.boxId} failed:`, e));
		this.jobs.forget(this);
	}

	/** Disconnect without stopping pi (bot shutdown). */
	detach(): void {
		this.finishing = true;
		clearTimeout(this.reconnectTimer);
		this.setBusy(false, false);
		this.rpc?.detach();
	}
}

/** An error whose message is meant for the user. */
export class UserError extends Error {}

export class Jobs {
	readonly cfg: Config;
	readonly state: State;
	readonly runtime: Runtime;
	readonly api: Api;
	private readonly live = new Map<number, Job>();
	private timer?: NodeJS.Timeout;

	constructor(cfg: Config, state: State, runtime: Runtime, api: Api) {
		this.cfg = cfg;
		this.state = state;
		this.runtime = runtime;
		this.api = api;
	}

	get(userId: number): Job | undefined {
		return this.live.get(userId);
	}

	/** Start a new job for the user. */
	async start(userId: number, user: User): Promise<Job> {
		if (this.live.has(userId)) throw new Error("job already running");
		await this.api.sendMessage(userId, "🔧 Setting up a fresh workspace for you. This takes about a minute…");
		const box = await this.runtime.create({
			userId,
			openrouterKey: user.openrouterKey,
			onProgress: (message) => void this.api.sendMessage(userId, message).catch(() => undefined),
		});
		const now = Date.now();
		const rec: JobRecord = {
			userId,
			boxId: box.id,
			createdAt: now,
			expiresAt: now + this.cfg.lifetimeMs,
			warned: false,
			busy: false,
			sent: {},
		};
		this.state.setJob(rec);
		const job = new Job(this, rec, box);
		this.live.set(userId, job);
		try {
			await job.connect();
		} catch (e) {
			await job.dispose();
			throw e;
		}
		await this.api.sendMessage(
			userId,
			`Your workspace is ready. It removes itself in ${formatDuration(this.cfg.lifetimeMs)}, and sends you its files first. /extend keeps it longer.`,
		);
		return job;
	}

	/** Called by a job once it's gone. */
	forget(job: Job): void {
		if (this.live.get(job.rec.userId) === job) this.live.delete(job.rec.userId);
		if (this.state.job(job.rec.userId)?.boxId === job.rec.boxId) this.state.deleteJob(job.rec.userId);
	}

	/** A job broke beyond repair: tell the user and clean up. */
	async lost(job: Job, message: string): Promise<void> {
		await job.sendText(message).catch(() => undefined);
		await job.dispose();
	}

	/** Pick up the jobs of the previous run and remove boxes nobody owns. */
	async restore(): Promise<void> {
		const existing = new Set(await this.runtime.list());
		const known = new Set(this.state.jobs().map((j) => j.boxId));
		for (const id of existing) {
			if (!known.has(id)) {
				console.log(`removing orphaned box ${id}`);
				await this.runtime.open(id).remove();
			}
		}
		for (const rec of this.state.jobs()) {
			const job = new Job(this, rec, this.runtime.open(rec.boxId));
			if (!existing.has(rec.boxId)) {
				await this.lost(job, "Your previous workspace was lost when the server restarted, sorry. Send a message to start a new one.");
				continue;
			}
			this.live.set(rec.userId, job);
			void job.reconnect();
		}
	}

	/** Check expiry every CHECK_INTERVAL_SECONDS (and right away). */
	startTimer(): void {
		const tick = () => {
			for (const job of this.live.values()) void this.check(job);
		};
		tick();
		this.timer = setInterval(tick, this.cfg.checkIntervalMs);
	}

	private async check(job: Job): Promise<void> {
		if (job.finishing) return;
		const left = job.rec.expiresAt - Date.now();
		if (left <= 0) {
			await job.finish("expired");
		} else if (!job.rec.warned && left <= this.cfg.warnBeforeMs) {
			job.rec.warned = true;
			this.state.setJob(job.rec);
			const keyboard = new InlineKeyboard().text(`Keep it ${formatDuration(this.cfg.lifetimeMs)} longer`, "extend");
			await job.enqueue(() =>
				this.api.sendMessage(
					job.chatId,
					`⏰ This workspace removes itself in about ${formatDuration(left)}. I'll send you its files first.`,
					{ reply_markup: keyboard },
				),
			);
		}
	}

	/** Bot shutdown: leave every job running, to be picked up next start. */
	detachAll(): void {
		clearInterval(this.timer);
		for (const job of this.live.values()) job.detach();
	}
}
