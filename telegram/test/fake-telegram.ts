// A minimal Bot API server for the end-to-end test: hands out scripted
// updates and records what the bot sends. getFile answers like the local Bot
// API server does, with an absolute path on disk.
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface Sent {
	method: string;
	chat_id?: number;
	text?: string;
	parse_mode?: string;
	reply_markup?: { inline_keyboard?: Array<Array<{ text: string; callback_data: string }>> };
	caption?: string;
	filename?: string;
	content?: Buffer;
}

export class FakeTelegram {
	readonly sent: Sent[] = [];
	readonly files = new Map<string, string>();
	private updates: unknown[] = [];
	private nextUpdateId = 1;
	private nextMessageId = 1;
	private waiters: Array<() => void> = [];
	private server?: Server;
	url = "";

	async start(): Promise<void> {
		this.server = createServer((req, res) => {
			this.handle(req)
				.then((result) => {
					res.setHeader("content-type", "application/json");
					res.end(JSON.stringify({ ok: true, result }));
				})
				.catch((e) => {
					res.statusCode = 400;
					res.end(JSON.stringify({ ok: false, error_code: 400, description: String(e) }));
				});
		});
		await new Promise<void>((r) => this.server!.listen(0, "127.0.0.1", r));
		this.url = `http://127.0.0.1:${(this.server!.address() as AddressInfo).port}`;
	}

	async stop(): Promise<void> {
		for (const w of this.waiters) w();
		this.server?.closeAllConnections();
		await new Promise((r) => this.server?.close(r));
	}

	private async body(req: IncomingMessage): Promise<Record<string, unknown>> {
		const type = req.headers["content-type"] ?? "";
		const chunks: Buffer[] = [];
		for await (const c of req) chunks.push(c as Buffer);
		const raw = Buffer.concat(chunks);
		if (type.includes("multipart/form-data")) {
			const form = await new Response(raw, { headers: { "content-type": type } }).formData();
			const out: Record<string, unknown> = {};
			for (const [key, value] of form) {
				if (typeof value === "string") out[key] = value;
				else {
					out.filename = value.name;
					out.content = Buffer.from(await value.arrayBuffer());
				}
			}
			return out;
		}
		return raw.length ? JSON.parse(raw.toString()) : {};
	}

	private async handle(req: IncomingMessage): Promise<unknown> {
		const method = req.url!.split("/").pop()!;
		const body = await this.body(req);
		switch (method) {
			case "getMe":
				return { id: 42, is_bot: true, first_name: "Test", username: "test_bot" };
			case "getUpdates": {
				const offset = Number(body.offset ?? 0);
				this.updates = this.updates.filter((u) => (u as { update_id: number }).update_id >= offset);
				if (this.updates.length === 0) {
					await new Promise<void>((r) => {
						const t = setTimeout(r, 1000);
						this.waiters.push(() => {
							clearTimeout(t);
							r();
						});
					});
				}
				return this.updates.filter((u) => (u as { update_id: number }).update_id >= offset);
			}
			case "getFile": {
				const path = this.files.get(String(body.file_id));
				if (!path) throw new Error("unknown file");
				return { file_id: body.file_id, file_unique_id: body.file_id, file_path: path };
			}
			case "sendMessage":
			case "sendDocument": {
				const sent: Sent = {
					method,
					chat_id: Number(body.chat_id),
					text: body.text as string | undefined,
					parse_mode: body.parse_mode as string | undefined,
					reply_markup: typeof body.reply_markup === "string" ? JSON.parse(body.reply_markup) : (body.reply_markup as Sent["reply_markup"]),
					caption: body.caption as string | undefined,
					filename: body.filename as string | undefined,
					content: body.content as Buffer | undefined,
				};
				if (method === "sendMessage" && sent.parse_mode === "HTML" && /<(?!\/?(b|i|s|code|pre|a|blockquote)\b)/.test(sent.text ?? "")) {
					throw new Error("Bad Request: can't parse entities");
				}
				this.sent.push(sent);
				return { message_id: this.nextMessageId++, date: 0, chat: { id: sent.chat_id, type: "private" } };
			}
			default:
				// sendChatAction, setMyCommands, answerCallbackQuery, editMessageReplyMarkup, ...
				return true;
		}
	}

	private push(update: Record<string, unknown>): void {
		this.updates.push({ update_id: this.nextUpdateId++, ...update });
		for (const w of this.waiters.splice(0)) w();
	}

	private message(userId: number, extra: Record<string, unknown>) {
		return {
			message_id: this.nextMessageId++,
			date: Math.floor(Date.now() / 1000),
			chat: { id: userId, type: "private" },
			from: { id: userId, is_bot: false, first_name: "U" },
			...extra,
		};
	}

	text(userId: number, text: string): void {
		const entities = text.startsWith("/") ? [{ type: "bot_command", offset: 0, length: text.split(" ")[0].length }] : undefined;
		this.push({ message: this.message(userId, { text, entities }) });
	}

	document(userId: number, path: string, fileName: string, caption?: string): void {
		const id = `doc-${this.nextUpdateId}`;
		this.files.set(id, path);
		this.push({ message: this.message(userId, { document: { file_id: id, file_unique_id: id, file_name: fileName }, caption }) });
	}

	voice(userId: number, path: string): void {
		const id = `voice-${this.nextUpdateId}`;
		this.files.set(id, path);
		this.push({ message: this.message(userId, { voice: { file_id: id, file_unique_id: id, duration: 2, file_size: 1000 } }) });
	}

	press(userId: number, data: string): void {
		this.push({
			callback_query: {
				id: `cb-${this.nextUpdateId}`,
				from: { id: userId, is_bot: false, first_name: "U" },
				chat_instance: "x",
				data,
				message: this.message(userId, { text: "buttons" }),
			},
		});
	}

	/** Wait for something sent to `chat` after index `from` to match. */
	async waitFor(chat: number, match: (s: Sent) => boolean, from = 0, timeoutMs = 15_000): Promise<Sent> {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			const found = this.sent.slice(from).find((s) => s.chat_id === chat && match(s));
			if (found) return found;
			await new Promise((r) => setTimeout(r, 50));
		}
		const recent = this.sent
			.filter((s) => s.chat_id === chat)
			.slice(-8)
			.map((s) => `${s.method}: ${s.text ?? s.filename}`);
		throw new Error(`timed out; last messages:\n${recent.join("\n")}`);
	}
}
