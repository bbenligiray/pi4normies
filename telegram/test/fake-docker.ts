// Just enough of the Docker Engine API, on a unix socket, to run the bot's
// DockerRuntime in tests without Docker. Containers are local processes in
// a directory that stands in for /home/ubuntu. Attach and exec streams use
// Docker's multiplexed framing, and archives go up and down as tar. It
// follows the API as documented (https://docs.docker.com/reference/api/engine/),
// so it tests the bot's plumbing, not Docker itself.
//
// HTTP is parsed by hand: like Docker's Go server, attach and exec start take
// over the connection right after the request headers, even when the request
// announces a chunked body that never ends, which Node's server won't do.
import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { Readable } from "node:stream";
import tar from "tar-stream";

const HOME = "/home/ubuntu";

interface FakeContainer {
	id: string;
	name: string;
	labels: Record<string, string>;
	env: string[];
	home: string;
	proc?: ChildProcess;
	attached: Set<Socket>;
}

interface FakeExec {
	container: FakeContainer;
	cmd: string[];
	cwd: string;
	running: boolean;
	exitCode?: number;
}

interface Request {
	method: string;
	url: URL;
	path: string;
	body: Buffer;
}

interface Response {
	status: number;
	body?: unknown;
	raw?: Buffer;
	contentType?: string;
}

function frame(stream: 1 | 2, data: Buffer): Buffer {
	const header = Buffer.alloc(8);
	header.writeUInt8(stream, 0);
	header.writeUInt32BE(data.length, 4);
	return Buffer.concat([header, data]);
}

const STATUS_TEXT: Record<number, string> = { 200: "OK", 201: "Created", 204: "No Content", 304: "Not Modified", 404: "Not Found", 500: "Server Error" };

export class FakeDocker {
	readonly socketPath: string;
	readonly containers = new Map<string, FakeContainer>();
	private readonly execs = new Map<string, FakeExec>();
	private readonly networks = new Set<string>();
	private server?: Server;
	private readonly sockets = new Set<Socket>();
	/** The command a container runs, given its home directory (stands in for pi-telegram). */
	private readonly command: (home: string) => { cmd: string; args: string[] };

	constructor(command: (home: string) => { cmd: string; args: string[] }) {
		this.command = command;
		this.socketPath = join(mkdtempSync(join(tmpdir(), "fake-docker-")), "docker.sock");
	}

	async start(): Promise<void> {
		this.server = createServer((socket) => this.connection(socket));
		await new Promise<void>((r) => this.server!.listen(this.socketPath, r));
	}

	async stop(): Promise<void> {
		for (const c of this.containers.values()) c.proc?.kill();
		for (const s of this.sockets) s.destroy();
		await new Promise((r) => this.server?.close(r));
	}

	/** Simulate pi crashing: the restart policy brings it back. */
	crash(id: string): void {
		this.containers.get(id)?.proc?.kill();
	}

	// --- HTTP/1.1, by hand ---------------------------------------------------

	private connection(socket: Socket): void {
		this.sockets.add(socket);
		socket.on("close", () => this.sockets.delete(socket));
		socket.on("error", () => undefined);
		let buffer = Buffer.alloc(0);
		let busy = false;
		const onData = (chunk: Buffer) => {
			buffer = Buffer.concat([buffer, chunk]);
			void pump();
		};
		const pump = async () => {
			if (busy) return;
			busy = true;
			try {
				for (;;) {
					const end = buffer.indexOf("\r\n\r\n");
					if (end < 0) return;
					const lines = buffer.subarray(0, end).toString("latin1").split("\r\n");
					const [method, target] = lines[0].split(" ");
					const headers = new Map(
						lines.slice(1).map((l) => [l.slice(0, l.indexOf(":")).trim().toLowerCase(), l.slice(l.indexOf(":") + 1).trim()]),
					);
					const url = new URL(target, "http://docker");
					const path = url.pathname.replace(/^\/v[\d.]+/, "");
					if (/^\/(containers\/[^/]+\/attach|exec\/[^/]+\/start)$/.test(path)) {
						// Hijack: from here on the connection is a raw stream.
						socket.off("data", onData);
						const rest = buffer.subarray(end + 4);
						const length = Number(headers.get("content-length") ?? 0);
						// Exec start's options are a JSON body; read and drop them.
						// Attach's (if any) are left in the stream, as stdin.
						this.hijack(method, url, path, socket, path.includes("/exec/") ? rest.subarray(length) : rest);
						return;
					}
					let body: Buffer;
					let consumed: number;
					if (headers.get("transfer-encoding")?.includes("chunked")) {
						const decoded = this.dechunk(buffer.subarray(end + 4));
						if (!decoded) return; // need more data
						[body, consumed] = [decoded.body, end + 4 + decoded.consumed];
					} else {
						const length = Number(headers.get("content-length") ?? 0);
						if (buffer.length < end + 4 + length) return;
						[body, consumed] = [buffer.subarray(end + 4, end + 4 + length), end + 4 + length];
					}
					buffer = buffer.subarray(consumed);
					let response: Response;
					try {
						response = await this.handle({ method, url, path, body });
					} catch (e) {
						response = { status: 500, body: { message: String(e) } };
					}
					const payload = response.raw ?? Buffer.from(response.body === undefined ? "" : JSON.stringify(response.body));
					socket.write(
						`HTTP/1.1 ${response.status} ${STATUS_TEXT[response.status] ?? "Status"}\r\n` +
							`Content-Type: ${response.contentType ?? "application/json"}\r\n` +
							`Content-Length: ${payload.length}\r\n\r\n`,
					);
					socket.write(payload);
				}
			} finally {
				busy = false;
			}
		};
		socket.on("data", onData);
	}

	private dechunk(data: Buffer): { body: Buffer; consumed: number } | undefined {
		const parts: Buffer[] = [];
		let pos = 0;
		for (;;) {
			const eol = data.indexOf("\r\n", pos);
			if (eol < 0) return undefined;
			const size = Number.parseInt(data.subarray(pos, eol).toString(), 16);
			if (data.length < eol + 2 + size + 2) return undefined;
			if (size === 0) return { body: Buffer.concat(parts), consumed: eol + 4 };
			parts.push(data.subarray(eol + 2, eol + 2 + size));
			pos = eol + 2 + size + 2;
		}
	}

	// --- the API ---------------------------------------------------------------

	private local(c: FakeContainer, p: string): string {
		if (!p.startsWith(`${HOME}/`) && p !== HOME) throw new Error(`fake docker: path outside home: ${p}`);
		return join(c.home, p.slice(HOME.length));
	}

	private find(id: string): FakeContainer | undefined {
		return this.containers.get(id) ?? [...this.containers.values()].find((c) => c.id.startsWith(id) || c.name === id);
	}

	private running(c: FakeContainer): boolean {
		return !!c.proc && c.proc.exitCode === null && c.proc.signalCode === null;
	}

	private startProcess(c: FakeContainer): void {
		const { cmd, args } = this.command(c.home);
		const env = Object.fromEntries(c.env.map((e) => [e.slice(0, e.indexOf("=")), e.slice(e.indexOf("=") + 1)]));
		const proc = spawn(cmd, args, { cwd: join(c.home, "job"), env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
		c.proc = proc;
		proc.stdin!.on("error", () => undefined);
		proc.stdout!.on("data", (d: Buffer) => {
			for (const s of c.attached) s.write(frame(1, d));
		});
		proc.stderr!.on("data", (d: Buffer) => {
			for (const s of c.attached) s.write(frame(2, d));
		});
		proc.on("exit", () => {
			// Docker ends every attach stream when the main process exits...
			for (const s of c.attached) s.end();
			c.attached.clear();
			// ...and restart policy unless-stopped starts it again, unless removed.
			setTimeout(() => {
				if (this.containers.has(c.id) && c.proc === proc) this.startProcess(c);
			}, 300);
		});
	}

	private async handle(req: Request): Promise<Response> {
		const { method, path, url } = req;
		const json = () => JSON.parse(req.body.toString() || "{}");
		let m: RegExpMatchArray | null;

		if (method === "GET" && /^\/images\/.+\/json$/.test(path)) return { status: 200, body: { Id: "sha256:x" } };
		if (method === "POST" && path === "/images/create") {
			const lines = [{ status: "Pulling" }, { status: "Status: Image is up to date" }].map((l) => JSON.stringify(l)).join("\n");
			return { status: 200, raw: Buffer.from(`${lines}\n`) };
		}
		if (method === "POST" && path === "/images/prune") return { status: 200, body: { ImagesDeleted: null } };

		if (method === "GET" && (m = path.match(/^\/networks\/([^/]+)$/))) {
			return this.networks.has(m[1]) ? { status: 200, body: { Name: m[1] } } : { status: 404, body: { message: "no such network" } };
		}
		if (method === "POST" && path === "/networks/create") {
			this.networks.add(json().Name);
			return { status: 201, body: { Id: randomUUID() } };
		}

		if (method === "POST" && path === "/containers/create") {
			const body = json();
			const id = (randomUUID() + randomUUID()).replace(/-/g, "");
			const home = mkdtempSync(join(tmpdir(), "fake-container-"));
			// What pi-telegram does before starting pi.
			mkdirSync(join(home, "job", "input"), { recursive: true });
			mkdirSync(join(home, "job", "output"), { recursive: true });
			const name = url.searchParams.get("name") ?? id;
			this.containers.set(id, { id, name, labels: body.Labels ?? {}, env: body.Env ?? [], home, attached: new Set() });
			return { status: 201, body: { Id: id, Warnings: [] } };
		}
		if (method === "GET" && path === "/containers/json") {
			const wanted: string[] = JSON.parse(url.searchParams.get("filters") ?? "{}").label ?? [];
			const list = [...this.containers.values()].filter((c) =>
				wanted.every((l) => {
					const [k, v] = l.split("=");
					return c.labels[k] === v;
				}),
			);
			return { status: 200, body: list.map((c) => ({ Id: c.id, Names: [`/${c.name}`], Labels: c.labels })) };
		}
		if ((m = path.match(/^\/containers\/([^/]+)(\/.*)?$/))) {
			const c = this.find(m[1]);
			const sub = m[2] ?? "";
			if (!c) return { status: 404, body: { message: `No such container: ${m[1]}` } };
			if (method === "GET" && sub === "/json") return { status: 200, body: { Id: c.id, State: { Running: this.running(c) } } };
			if (method === "POST" && sub === "/start") {
				if (this.running(c)) return { status: 304 };
				this.startProcess(c);
				return { status: 204 };
			}
			if (method === "DELETE" && sub === "") {
				this.containers.delete(c.id);
				c.proc?.kill();
				rmSync(c.home, { recursive: true, force: true });
				return { status: 204 };
			}
			if (method === "POST" && sub === "/exec") {
				const body = json();
				const id = randomUUID();
				this.execs.set(id, { container: c, cmd: body.Cmd, cwd: this.local(c, body.WorkingDir ?? HOME), running: false });
				return { status: 201, body: { Id: id } };
			}
			if (sub === "/archive") return this.archive(req, c, url.searchParams.get("path")!);
		}
		if (method === "GET" && (m = path.match(/^\/exec\/([^/]+)\/json$/))) {
			const e = this.execs.get(m[1]);
			if (!e) return { status: 404, body: { message: "no such exec" } };
			return { status: 200, body: { Running: e.running, ExitCode: e.running ? null : (e.exitCode ?? 0) } };
		}
		return { status: 404, body: { message: `fake docker: unsupported ${method} ${path}` } };
	}

	private async archive(req: Request, c: FakeContainer, path: string): Promise<Response> {
		const local = this.local(c, path);
		if (!existsSync(local)) return { status: 404, body: { message: `Could not find the file ${path} in container` } };
		if (req.method === "PUT") {
			const extract = tar.extract();
			const done = new Promise<void>((resolve, reject) => {
				extract.on("entry", (header, stream, next) => {
					if (header.name.includes("/") || header.type !== "file") return reject(new Error("fake docker: unexpected tar entry"));
					const chunks: Buffer[] = [];
					stream.on("data", (d) => {
						chunks.push(d as Buffer);
					});
					stream.on("end", () => {
						writeFileSync(join(local, header.name), Buffer.concat(chunks));
						next();
					});
				});
				extract.on("finish", resolve);
				extract.on("error", reject);
			});
			Readable.from([req.body]).pipe(extract);
			await done;
			return { status: 200 };
		}
		if (req.method === "GET") {
			const pack = tar.pack();
			const content = readFileSync(local);
			pack.entry({ name: basename(local), size: content.length }, content);
			pack.finalize();
			const chunks: Buffer[] = [];
			for await (const chunk of pack) chunks.push(chunk as Buffer);
			return { status: 200, raw: Buffer.concat(chunks), contentType: "application/x-tar" };
		}
		return { status: 404, body: {} };
	}

	private hijack(method: string, url: URL, path: string, socket: Socket, rest: Buffer): void {
		socket.write("HTTP/1.1 101 UPGRADED\r\nContent-Type: application/vnd.docker.raw-stream\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n");
		let m: RegExpMatchArray | null;
		if ((m = path.match(/^\/containers\/([^/]+)\/attach$/))) {
			const c = this.find(m[1]);
			if (!c || method !== "POST" || url.searchParams.get("stdin") !== "true") return void socket.destroy();
			c.attached.add(socket);
			// Stdin from an attached client goes to the current process,
			// including anything sent after the headers, as Docker might.
			if (rest.length) c.proc?.stdin?.write(rest);
			socket.on("data", (d: Buffer) => {
				c.proc?.stdin?.write(d);
			});
			socket.on("close", () => c.attached.delete(socket));
			return;
		}
		if ((m = path.match(/^\/exec\/([^/]+)\/start$/))) {
			const e = this.execs.get(m[1]);
			if (!e) return void socket.destroy();
			e.running = true;
			const proc = spawn(e.cmd[0], e.cmd.slice(1), { cwd: e.cwd, stdio: ["ignore", "pipe", "pipe"] });
			proc.stdout.on("data", (d: Buffer) => socket.write(frame(1, d)));
			proc.stderr.on("data", (d: Buffer) => socket.write(frame(2, d)));
			proc.on("close", (code) => {
				e.exitCode = code ?? 1;
				// Like Docker, the stream can end a moment before inspect shows the exit.
				socket.end();
				setTimeout(() => (e.running = false), 50);
			});
		}
	}
}
