import { readFileSync } from "node:fs";

// The allowlist, with each user's OpenRouter key: config/users.json, e.g.
//
//   {
//     "123456789": { "name": "Alice", "openrouterKey": "sk-or-v1-..." }
//   }
//
// Keys are Telegram user IDs. Read on every use, so edits apply without a
// restart (a new key applies from the user's next job).

export interface User {
	name?: string;
	openrouterKey: string;
}

export class Users {
	private readonly file: string;

	constructor(file: string) {
		this.file = file;
	}

	private load(): Record<string, User> {
		let raw: string;
		try {
			raw = readFileSync(this.file, "utf8");
		} catch (e) {
			console.error(`Can't read ${this.file}:`, (e as Error).message);
			return {};
		}
		try {
			const parsed = JSON.parse(raw);
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("expected an object");
			return parsed;
		} catch (e) {
			// Keep running on a typo; nobody gets in until it's fixed.
			console.error(`${this.file} is not valid:`, (e as Error).message);
			return {};
		}
	}

	get(userId: number): User | undefined {
		const user = this.load()[String(userId)];
		if (!user || typeof user.openrouterKey !== "string" || !user.openrouterKey.trim()) return undefined;
		return { ...user, openrouterKey: user.openrouterKey.trim() };
	}

	/** Startup sanity check: number of usable entries. */
	count(): number {
		return Object.keys(this.load()).filter((id) => this.get(Number(id))).length;
	}
}
