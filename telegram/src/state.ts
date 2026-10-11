import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

// The bot's memory across restarts: which job belongs to whom and when it
// expires. Small, so it's one JSON file rewritten atomically on every change.

export interface JobRecord {
	userId: number;
	boxId: string;
	createdAt: number;
	expiresAt: number;
	/** The "removes itself soon" warning has been sent for this expiry. */
	warned: boolean;
	/** pi was working on something (to tell what happened after a reconnect). */
	busy: boolean;
	/** output/ files already sent: relative path → "size:mtime". */
	sent: Record<string, string>;
}

interface Data {
	jobs: Record<string, JobRecord>;
	/** The bot was logged out of api.telegram.org (needed once for the local Bot API server). */
	cloudLoggedOut?: boolean;
}

export class State {
	private readonly file: string;
	private data: Data;

	constructor(file: string) {
		this.file = file;
		try {
			this.data = JSON.parse(readFileSync(file, "utf8"));
			this.data.jobs ??= {};
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
			this.data = { jobs: {} };
		}
	}

	save(): void {
		mkdirSync(dirname(this.file), { recursive: true });
		const tmp = `${this.file}.tmp`;
		writeFileSync(tmp, `${JSON.stringify(this.data, null, "\t")}\n`, { mode: 0o600 });
		renameSync(tmp, this.file);
	}

	jobs(): JobRecord[] {
		return Object.values(this.data.jobs);
	}

	job(userId: number): JobRecord | undefined {
		return this.data.jobs[userId];
	}

	setJob(job: JobRecord): void {
		this.data.jobs[job.userId] = job;
		this.save();
	}

	deleteJob(userId: number): void {
		delete this.data.jobs[userId];
		this.save();
	}

	get cloudLoggedOut(): boolean {
		return !!this.data.cloudLoggedOut;
	}

	set cloudLoggedOut(value: boolean) {
		this.data.cloudLoggedOut = value;
		this.save();
	}
}
