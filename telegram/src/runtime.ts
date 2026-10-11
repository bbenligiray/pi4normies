import type { Readable } from "node:stream";

// Where a job runs. In production that's one Docker container per job
// (docker.ts); local.ts runs pi as a plain process, for development and tests.
// Paths given to a Box are relative to the job's working directory, the one
// with input/ and output/ in it.

/** pi's RPC stdio. */
export interface PiStdio {
	stdout: Readable;
	write(data: string): void;
	/** Let go of the stdio without stopping pi (it keeps running in the box). */
	detach(): void;
}

export interface ExecResult {
	code: number;
	stdout: string;
	stderr: string;
}

export interface BoxStatus {
	exists: boolean;
	running: boolean;
}

export interface Box {
	readonly id: string;
	/** Connect to pi's stdio, starting the box first if it isn't running. */
	attach(): Promise<PiStdio>;
	status(): Promise<BoxStatus>;
	/** Run a program (no shell) in the job directory, as the job's user. */
	exec(argv: string[], timeoutMs?: number): Promise<ExecResult>;
	/** Copy a local file into the box as `dir/name`. */
	putFile(dir: string, name: string, localPath: string): Promise<void>;
	/** Copy a regular file out of the box to a local path. */
	getFile(path: string, localPath: string): Promise<void>;
	/** Stop and delete the box and everything in it. */
	remove(): Promise<void>;
}

export interface CreateOptions {
	userId: number;
	openrouterKey: string;
	/** Progress for the user while the box is being prepared (e.g. image pull). */
	onProgress?: (message: string) => void;
}

export interface Runtime {
	create(opts: CreateOptions): Promise<Box>;
	/** A handle on an existing box (it may have disappeared meanwhile). */
	open(id: string): Box;
	/** Ids of every box this bot created that still exists. */
	list(): Promise<string[]>;
}
