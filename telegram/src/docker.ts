import Docker from "dockerode";
import { createReadStream, createWriteStream } from "node:fs";
import { stat } from "node:fs/promises";
import { PassThrough, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import tar from "tar-stream";
import type { Config } from "./config.ts";
import type { Box, BoxStatus, CreateOptions, ExecResult, PiStdio, Runtime } from "./runtime.ts";

// One container per job, from the same image the codespaces use. Its main
// process is `pi-telegram` (scripts/pi-telegram in the repo): pi in RPC mode
// on the container's stdin/stdout, which the bot attaches to. The workspace
// lives in the container's own filesystem, so removing the container removes
// everything; files go in and out through the Docker API, never through host
// paths, so nothing the agent does inside (symlinks etc.) reaches the host.

const LABEL = "pi4normies.job";
const USER_LABEL = "pi4normies.user";
const HOME = "/home/ubuntu";
const JOB_DIR = `${HOME}/job`;
const UID = 1000;
const PULL_TIMEOUT_MS = 10 * 60_000;

function isNotFound(e: unknown): boolean {
	return (e as { statusCode?: number })?.statusCode === 404;
}

function abs(path: string): string {
	if (path.startsWith("/") || path.split("/").includes("..")) throw new Error(`Bad path: ${path}`);
	return `${JOB_DIR}/${path}`;
}

/** Demultiplex a non-TTY Docker stream (attach or exec) into stdout and stderr. */
function demux(docker: Docker, stream: NodeJS.ReadableStream): { stdout: PassThrough; stderr: PassThrough } {
	const stdout = new PassThrough();
	const stderr = new PassThrough();
	docker.modem.demuxStream(stream, stdout, stderr);
	const end = () => {
		stdout.end();
		stderr.end();
	};
	stream.on("end", end);
	stream.on("close", end);
	stream.on("error", end);
	return { stdout, stderr };
}

class DockerBox implements Box {
	readonly id: string;
	private readonly docker: Docker;
	private readonly container: Docker.Container;

	constructor(docker: Docker, id: string) {
		this.docker = docker;
		this.id = id;
		this.container = docker.getContainer(id);
	}

	async status(): Promise<BoxStatus> {
		try {
			const info = await this.container.inspect();
			return { exists: true, running: info.State.Running };
		} catch (e) {
			if (isNotFound(e)) return { exists: false, running: false };
			throw e;
		}
	}

	async attach(): Promise<PiStdio> {
		// Attach before starting, so nothing pi prints at startup is missed.
		const stream = (await this.container.attach({
			stream: true,
			stdin: true,
			stdout: true,
			stderr: true,
			hijack: true,
		})) as NodeJS.ReadWriteStream & { destroy(): void };
		// docker-modem also sends the options as a JSON request body (without
		// one, Node never sends the request), on the connection that becomes
		// pi's stdin. Docker may pass those bytes on to pi. Ending the line here
		// keeps them (or a line a previous connection left unfinished) from
		// running into our first command; pi rejects such lines harmlessly.
		stream.write("\n");
		const { stdout, stderr } = demux(this.docker, stream);
		// pi's stderr (and post-create's output) is diagnostics only.
		stderr.on("data", (chunk: Buffer) => process.stderr.write(`[${this.id.slice(0, 12)}] ${chunk}`));
		if (!(await this.status()).running) {
			try {
				await this.container.start();
			} catch (e) {
				// 304: already started (e.g. by the restart policy) in the meantime.
				if ((e as { statusCode?: number })?.statusCode !== 304) {
					stream.destroy();
					throw e;
				}
			}
		}
		return {
			stdout,
			write: (data) => {
				stream.write(data);
			},
			// The container is created with StdinOnce=false, so dropping the
			// attach connection leaves pi's stdin open and pi running.
			detach: () => stream.destroy(),
		};
	}

	async exec(argv: string[], timeoutMs = 120_000): Promise<ExecResult> {
		const exec = await this.container.exec({
			Cmd: argv,
			AttachStdout: true,
			AttachStderr: true,
			User: "ubuntu",
			WorkingDir: JOB_DIR,
		});
		const stream = await exec.start({ hijack: true, stdin: false });
		const { stdout, stderr } = demux(this.docker, stream);
		const collect = async (s: Readable) => {
			const chunks: Buffer[] = [];
			for await (const chunk of s) chunks.push(chunk as Buffer);
			return Buffer.concat(chunks).toString("utf8");
		};
		const timer = setTimeout(() => (stream as unknown as { destroy(): void }).destroy(), timeoutMs);
		try {
			const [out, err] = await Promise.all([collect(stdout), collect(stderr)]);
			// The stream can close a moment before Docker records the exit code.
			let info = await exec.inspect();
			for (let i = 0; info.Running && i < 20; i++) {
				await new Promise((r) => setTimeout(r, 100));
				info = await exec.inspect();
			}
			return { code: info.Running ? -1 : (info.ExitCode ?? -1), stdout: out, stderr: err };
		} finally {
			clearTimeout(timer);
		}
	}

	async putFile(dir: string, name: string, localPath: string): Promise<void> {
		if (name.includes("/")) throw new Error(`Bad file name: ${name}`);
		const { size } = await stat(localPath);
		const pack = tar.pack();
		const entry = pack.entry({ name, size, mode: 0o644, uid: UID, gid: UID, mtime: new Date() }, (err) => {
			if (err) pack.destroy(err);
			else pack.finalize();
		});
		const upload = this.container.putArchive(pack as unknown as NodeJS.ReadableStream, { path: abs(dir) }).then(
			// Drain the (empty) response so the socket is released.
			(response) => (response as unknown as Readable | undefined)?.resume?.(),
			(e: Error) => {
				pack.destroy(e);
				throw e;
			},
		);
		await Promise.all([upload, pipeline(createReadStream(localPath), entry)]);
	}

	async getFile(path: string, localPath: string): Promise<void> {
		const archive = (await this.container.getArchive({ path: abs(path) })) as Readable;
		const extract = tar.extract();
		let found = false;
		extract.on("entry", (header, stream, next) => {
			if (found || header.type !== "file") {
				stream.on("end", next);
				stream.resume();
				return;
			}
			found = true;
			// A failed write fails the whole pipeline (instead of stalling it).
			pipeline(stream, createWriteStream(localPath)).then(
				() => next(),
				(e) => extract.destroy(e),
			);
		});
		// pipeline (unlike pipe) also surfaces errors on the archive stream itself.
		await pipeline(archive, extract);
		if (!found) throw new Error(`Not a regular file: ${path}`);
	}

	async remove(): Promise<void> {
		try {
			await this.container.remove({ force: true, v: true });
		} catch (e) {
			if (!isNotFound(e)) throw e;
		}
	}
}

export class DockerRuntime implements Runtime {
	private readonly docker = new Docker();
	private readonly cfg: Config;

	constructor(cfg: Config) {
		this.cfg = cfg;
	}

	open(id: string): Box {
		return new DockerBox(this.docker, id);
	}

	async list(): Promise<string[]> {
		const containers = await this.docker.listContainers({ all: true, filters: { label: [`${LABEL}=1`] } });
		return containers.map((c) => c.Id);
	}

	async create(opts: CreateOptions): Promise<Box> {
		await this.pull(opts.onProgress);
		await this.ensureNetwork();
		const cfg = this.cfg;
		const container = await this.docker.createContainer({
			name: `pi4normies-${opts.userId}-${Date.now().toString(36)}`,
			Image: cfg.image,
			Cmd: ["pi-telegram"],
			User: "ubuntu",
			Env: [`OPENROUTER_API_KEY=${opts.openrouterKey}`],
			Labels: { [LABEL]: "1", [USER_LABEL]: String(opts.userId) },
			Tty: false,
			OpenStdin: true,
			StdinOnce: false,
			AttachStdin: true,
			AttachStdout: true,
			AttachStderr: true,
			HostConfig: {
				// Reaps zombies (Chrome leaves plenty).
				Init: true,
				Memory: cfg.memoryBytes,
				MemorySwap: cfg.memoryBytes,
				NanoCpus: Math.round(cfg.cpus * 1e9),
				PidsLimit: cfg.pids,
				ShmSize: cfg.shmBytes,
				NetworkMode: cfg.network,
				// pi crashing, or the machine rebooting, shouldn't end the job;
				// pi-telegram resumes the conversation (pi --continue).
				RestartPolicy: { Name: "unless-stopped" },
				// pi's stdout is the RPC stream: nobody needs it in a log file.
				LogConfig: { Type: "none", Config: {} },
			},
		});
		return new DockerBox(this.docker, container.id);
	}

	/** Pull the image so each job gets the latest daily build; fall back to a local copy. */
	private async pull(onProgress?: (message: string) => void): Promise<void> {
		const image = this.cfg.image;
		const hasLocal = await this.docker
			.getImage(image)
			.inspect()
			.then(() => true)
			.catch(() => false);
		if (!hasLocal) onProgress?.("Downloading the assistant (first time only, a few minutes)…");
		try {
			const stream = await this.docker.pull(image);
			await new Promise<void>((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error("image pull timed out")), PULL_TIMEOUT_MS);
				this.docker.modem.followProgress(stream, (err) => {
					clearTimeout(timer);
					if (err) reject(err);
					else resolve();
				});
			});
			// Daily builds leave the previous image behind untagged.
			await this.docker.pruneImages({ filters: { dangling: ["true"] } }).catch(() => undefined);
		} catch (e) {
			if (!hasLocal) throw e;
			console.warn(`Pulling ${image} failed, using the local copy:`, (e as Error).message);
		}
	}

	/** A bridge network of its own, where job containers can't talk to each other. */
	private async ensureNetwork(): Promise<void> {
		const name = this.cfg.network;
		try {
			await this.docker.getNetwork(name).inspect();
		} catch (e) {
			if (!isNotFound(e)) throw e;
			await this.docker.createNetwork({
				Name: name,
				Driver: "bridge",
				Labels: { [LABEL]: "network" },
				Options: { "com.docker.network.bridge.enable_icc": "false" },
			});
		}
	}
}
