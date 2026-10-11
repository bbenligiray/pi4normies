import { rmSync } from "node:fs";
import { join } from "node:path";
import { run } from "@grammyjs/runner";
import { COMMANDS, createBot, registerHandlers } from "./bot.ts";
import { loadConfig } from "./config.ts";
import { DockerRuntime } from "./docker.ts";
import { Jobs } from "./jobs.ts";
import { LocalRuntime } from "./local.ts";
import type { Runtime } from "./runtime.ts";
import { State } from "./state.ts";
import { Users } from "./users.ts";

const cfg = loadConfig();
const state = new State(join(cfg.dataDir, "state.json"));
const users = new Users(cfg.usersFile);
const runtime: Runtime = cfg.runtime === "docker" ? new DockerRuntime(cfg) : new LocalRuntime(cfg.dataDir, cfg.localPiCommand);

console.log(`${users.count()} user(s) in ${cfg.usersFile}`);
// Leftovers of file transfers cut short by the last shutdown.
rmSync(join(cfg.dataDir, "tmp"), { recursive: true, force: true });

// The local Bot API server only works once the bot is logged out of
// Telegram's cloud server (https://core.telegram.org/bots/api#logout).
if (cfg.cloudLogout && !state.cloudLoggedOut && !cfg.apiRoot.startsWith("https://api.telegram.org")) {
	try {
		const response = await fetch(`https://api.telegram.org/bot${cfg.botToken}/logOut`, { method: "POST" });
		const body = (await response.json()) as { ok: boolean; description?: string };
		if (body.ok || /logged out/i.test(body.description ?? "")) {
			console.log("Logged the bot out of api.telegram.org (one-time step for the local Bot API server).");
			state.cloudLoggedOut = true;
		} else {
			console.warn("Logging out of api.telegram.org failed:", body.description);
		}
	} catch (e) {
		console.warn("Logging out of api.telegram.org failed:", (e as Error).message);
	}
}

const bot = createBot(cfg);
const jobs = new Jobs(cfg, state, runtime, bot.api);
registerHandlers(bot, cfg, jobs, users);

// The Bot API server may still be starting.
for (let attempt = 1; ; attempt++) {
	try {
		await bot.init();
		break;
	} catch (e) {
		if (attempt >= 30) throw e;
		console.warn(`Waiting for the Bot API server at ${cfg.apiRoot}: ${(e as Error).message}`);
		await new Promise((r) => setTimeout(r, 2_000));
	}
}
console.log(`Running as @${bot.botInfo.username}`);
await bot.api.setMyCommands(COMMANDS).catch((e) => console.warn("setMyCommands failed:", e.message));

await jobs.restore();
jobs.startTimer();

const runner = run(bot, { runner: { fetch: { allowed_updates: ["message", "callback_query"] } } });

let stopping = false;
async function shutdown(signal: string): Promise<void> {
	if (stopping) return;
	stopping = true;
	console.log(`${signal}: stopping (jobs keep running and are picked up on the next start)`);
	await runner.stop().catch(() => undefined);
	jobs.detachAll();
	if (runtime instanceof LocalRuntime) await runtime.stopAll();
	process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
