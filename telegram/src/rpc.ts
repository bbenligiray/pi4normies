import { StringDecoder } from "node:string_decoder";
import type { PiStdio } from "./runtime.ts";

// Client for pi's RPC mode (docs: rpc.md, rpc-commands.md, json.md in
// @earendil-works/pi-coding-agent). Records are JSON objects, one per line,
// split on LF only: U+2028/U+2029 are valid inside JSON strings, so no
// readline.

export type RpcRecord = { type: string; [key: string]: unknown };

interface Pending {
	resolve(data: unknown): void;
	reject(err: Error): void;
	timer: NodeJS.Timeout;
}

export class RpcError extends Error {}

export class PiRpc {
	private readonly io: PiStdio;
	private readonly pending = new Map<string, Pending>();
	private readonly listeners = new Set<(record: RpcRecord) => void>();
	private readonly closeListeners = new Set<() => void>();
	private readonly onData: (chunk: Buffer) => void;
	private nextId = 1;
	closed = false;

	constructor(io: PiStdio) {
		this.io = io;
		const decoder = new StringDecoder("utf8");
		let buffer = "";
		this.onData = (chunk: Buffer) => {
			if (this.closed) return;
			buffer += decoder.write(chunk);
			let nl: number;
			while ((nl = buffer.indexOf("\n")) >= 0) {
				const line = buffer.slice(0, nl).replace(/\r$/, "");
				buffer = buffer.slice(nl + 1);
				if (line.trim()) this.handleLine(line);
			}
		};
		io.stdout.on("data", this.onData);
		const onClose = () => this.close();
		io.stdout.on("end", onClose);
		io.stdout.on("close", onClose);
		io.stdout.on("error", onClose);
	}

	private handleLine(line: string): void {
		let record: RpcRecord;
		try {
			record = JSON.parse(line);
		} catch {
			// Not ours (stray output from something in the container).
			console.warn("pi rpc: ignoring non-JSON line:", line.slice(0, 200));
			return;
		}
		if (record.type === "response" && typeof record.id === "string" && this.pending.has(record.id)) {
			const p = this.pending.get(record.id)!;
			this.pending.delete(record.id);
			clearTimeout(p.timer);
			if (record.success) p.resolve(record.data);
			else p.reject(new RpcError(String(record.error ?? `${record.command} failed`)));
			return;
		}
		for (const listener of this.listeners) {
			try {
				listener(record);
			} catch (e) {
				console.error("pi rpc listener failed:", e);
			}
		}
	}

	onRecord(listener: (record: RpcRecord) => void): void {
		this.listeners.add(listener);
	}

	onClose(listener: () => void): void {
		this.closeListeners.add(listener);
	}

	/** Send a command and wait for its response's `data`. */
	request<T = unknown>(command: RpcRecord, timeoutMs = 60_000): Promise<T> {
		if (this.closed) return Promise.reject(new RpcError("The assistant is not running"));
		const id = `bot-${this.nextId++}`;
		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new RpcError(`${command.type} timed out`));
			}, timeoutMs);
			this.pending.set(id, { resolve: resolve as (data: unknown) => void, reject, timer });
			this.io.write(`${JSON.stringify({ ...command, id })}\n`);
		});
	}

	/** Send a record that has no response (e.g. extension_ui_response). */
	send(record: RpcRecord): void {
		if (!this.closed) this.io.write(`${JSON.stringify(record)}\n`);
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		// The box may hand the same stream to the next connection (local
		// runtime), which must then be the only one handling its records.
		this.io.stdout.off("data", this.onData);
		for (const p of this.pending.values()) {
			clearTimeout(p.timer);
			p.reject(new RpcError("The assistant stopped"));
		}
		this.pending.clear();
		for (const listener of this.closeListeners) listener();
	}

	/** Disconnect without stopping pi. */
	detach(): void {
		this.io.detach();
		this.close();
	}
}
