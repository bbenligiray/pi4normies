// Everything is configured through environment variables (see .env.example).

function env(name: string, fallback?: string): string {
	const value = process.env[name]?.trim();
	if (value) return value;
	if (fallback !== undefined) return fallback;
	throw new Error(`Missing environment variable ${name} (see .env.example)`);
}

function num(name: string, fallback: number): number {
	const raw = process.env[name]?.trim();
	if (!raw) return fallback;
	const value = Number(raw);
	if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number, got "${raw}"`);
	return value;
}

/** "4g", "512m", "2048" (bytes) → bytes. */
export function parseBytes(raw: string): number {
	const m = raw.trim().toLowerCase().match(/^(\d+(?:\.\d+)?)\s*([kmgt]?)b?$/);
	if (!m) throw new Error(`Not a size: "${raw}" (use e.g. 4g or 512m)`);
	const power = { "": 0, k: 1, m: 2, g: 3, t: 4 }[m[2] as "" | "k" | "m" | "g" | "t"];
	return Math.round(Number(m[1]) * 1024 ** power);
}

export interface Config {
	botToken: string;
	/** The local Bot API server (no 20/50 MB file limits). */
	apiRoot: string;
	/** Log the bot out of api.telegram.org once, as the local server requires. */
	cloudLogout: boolean;
	dataDir: string;
	usersFile: string;
	runtime: "docker" | "local";
	image: string;
	network: string;
	memoryBytes: number;
	cpus: number;
	pids: number;
	shmBytes: number;
	lifetimeMs: number;
	warnBeforeMs: number;
	/** How often expiry is checked. */
	checkIntervalMs: number;
	transcribeModel: string;
	/** For RUNTIME=local: the command that starts pi in RPC mode. */
	localPiCommand: string;
}

export function loadConfig(): Config {
	const runtime = env("RUNTIME", "docker");
	if (runtime !== "docker" && runtime !== "local") throw new Error(`RUNTIME must be docker or local, got "${runtime}"`);
	return {
		botToken: env("TELEGRAM_BOT_TOKEN"),
		apiRoot: env("TELEGRAM_API_ROOT", "http://telegram-bot-api:8081").replace(/\/+$/, ""),
		cloudLogout: env("TELEGRAM_CLOUD_LOGOUT", "1") !== "0",
		dataDir: env("DATA_DIR", "/data"),
		usersFile: env("USERS_FILE", "/config/users.json"),
		runtime,
		image: env("JOB_IMAGE", "ghcr.io/bbenligiray/pi4normies:latest"),
		network: env("JOB_NETWORK", "pi4normies-jobs"),
		memoryBytes: parseBytes(env("JOB_MEMORY", "4g")),
		cpus: num("JOB_CPUS", 2),
		pids: num("JOB_PIDS", 4096),
		shmBytes: parseBytes(env("JOB_SHM", "1g")),
		lifetimeMs: num("JOB_LIFETIME_HOURS", 24) * 3600_000,
		warnBeforeMs: num("JOB_WARN_MINUTES", 60) * 60_000,
		checkIntervalMs: num("CHECK_INTERVAL_SECONDS", 30) * 1000,
		transcribeModel: env("TRANSCRIBE_MODEL", "openai/whisper-large-v3"),
		localPiCommand: env("LOCAL_PI_COMMAND", "pi --mode rpc --continue"),
	};
}
