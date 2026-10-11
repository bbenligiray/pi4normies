import { type ChildProcess, execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFile, lstat, mkdir, readdir, rm } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import type { Box, BoxStatus, CreateOptions, ExecResult, PiStdio, Runtime } from "./runtime.ts";

// RUNTIME=local: each job is a directory under DATA_DIR/local-jobs with pi
// running as a plain child process of the bot. No isolation at all, and jobs
// don't survive a bot restart. Only for developing the bot without Docker,
// and for the tests.

class LocalBox implements Box {
	readonly id: string;
	private readonly dir: string;
	private readonly runtime: LocalRuntime;

	constructor(runtime: LocalRuntime, id: string) {
		this.runtime = runtime;
		this.id = id;
		this.dir = join(runtime.root, id);
	}

	private path(rel: string): string {
		const full = resolve(this.dir, rel);
		if (!full.startsWith(this.dir + sep)) throw new Error(`Bad path: ${rel}`);
		return full;
	}

	async status(): Promise<BoxStatus> {
		const exists = await lstat(this.dir).then(
			() => true,
			() => false,
		);
		const proc = this.runtime.procs.get(this.id);
		return { exists, running: exists && !!proc && proc.exitCode === null && proc.signalCode === null };
	}

	async attach(): Promise<PiStdio> {
		let proc = this.runtime.procs.get(this.id);
		if (!proc || proc.exitCode !== null || proc.signalCode !== null) {
			proc = spawn("sh", ["-c", this.runtime.command], {
				cwd: this.dir,
				env: { ...process.env, OPENROUTER_API_KEY: this.runtime.keys.get(this.id) ?? "" },
				stdio: ["pipe", "pipe", "inherit"],
			});
			this.runtime.procs.set(this.id, proc);
		}
		const child = proc;
		return {
			stdout: child.stdout!,
			write: (data) => {
				child.stdin!.write(data);
			},
			detach: () => undefined,
		};
	}

	exec(argv: string[], timeoutMs = 120_000): Promise<ExecResult> {
		return new Promise((done) => {
			execFile(argv[0], argv.slice(1), { cwd: this.dir, timeout: timeoutMs, maxBuffer: 64 << 20 }, (err, stdout, stderr) => {
				const code = err ? (typeof err.code === "number" ? err.code : 1) : 0;
				done({ code, stdout: String(stdout), stderr: String(stderr) });
			});
		});
	}

	async putFile(dir: string, name: string, localPath: string): Promise<void> {
		if (name.includes("/")) throw new Error(`Bad file name: ${name}`);
		await copyFile(localPath, this.path(join(dir, name)));
	}

	async getFile(path: string, localPath: string): Promise<void> {
		const full = this.path(path);
		if (!(await lstat(full)).isFile()) throw new Error(`Not a regular file: ${path}`);
		await copyFile(full, localPath);
	}

	async remove(): Promise<void> {
		const proc = this.runtime.procs.get(this.id);
		proc?.kill();
		this.runtime.procs.delete(this.id);
		await rm(this.dir, { recursive: true, force: true });
	}
}

export class LocalRuntime implements Runtime {
	readonly root: string;
	readonly command: string;
	readonly procs = new Map<string, ChildProcess>();
	readonly keys = new Map<string, string>();

	constructor(dataDir: string, command: string) {
		this.root = resolve(dataDir, "local-jobs");
		this.command = command;
	}

	open(id: string): Box {
		return new LocalBox(this, id);
	}

	async list(): Promise<string[]> {
		await mkdir(this.root, { recursive: true });
		return readdir(this.root);
	}

	async create(opts: CreateOptions): Promise<Box> {
		const id = `${opts.userId}-${randomUUID().slice(0, 8)}`;
		const dir = join(this.root, id);
		await mkdir(join(dir, "input"), { recursive: true });
		await mkdir(join(dir, "output"), { recursive: true });
		this.keys.set(id, opts.openrouterKey);
		return new LocalBox(this, id);
	}

	/** Stop every pi process and wait for them (on shutdown). */
	async stopAll(): Promise<void> {
		const exits = [...this.procs.values()]
			.filter((proc) => proc.exitCode === null && proc.signalCode === null)
			.map((proc) => {
				const exited = new Promise((r) => proc.once("exit", r));
				// Closing stdin is how pi's RPC mode is told to quit.
				proc.stdin?.end();
				const timer = setTimeout(() => proc.kill(), 2_000);
				return exited.finally(() => clearTimeout(timer));
			});
		await Promise.all(exits);
	}
}
