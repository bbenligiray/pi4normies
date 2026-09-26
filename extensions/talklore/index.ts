import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

// Talklore: bring what the user's Talklore voice agents remember into the
// assistant's context. talklore-one serves the export (Markdown, "talklore
// export v1") at https://<host>/export/<token>, live for 24 hours; this file
// relies only on the parts of that format described below.
//
// The user pastes their export link (https://<host>/export/<token>) into the
// chat. Before the model runs, the link is fetched, checked for the export
// marker, saved to ~/talklore/, and added to the system prompt as a
// <talklore> section, on every turn from then on (so it survives
// compaction). The link is live for 24 hours: it's re-fetched at most every
// REFRESH_MS while valid, and the last good copy is kept when it expires or
// fails. The link is remembered in the session, so resuming restores it.
//
// The talklore_load tool covers what auto-detection can't: a link the
// pattern missed, or an explicit "refresh my Talklore".

const MARKER = "<!-- talklore-export v1 -->";
// https://<host>/export/<token>, token opaque and URL-safe (>= 128 bits).
const LINK_RE = /https?:\/\/[^\s<>"'()]+\/export\/[A-Za-z0-9_-]{16,}/;
const REFRESH_MS = 10 * 60_000;
const FETCH_TIMEOUT_MS = 20_000;
// Above this, only headings and dates go into the prompt (~20k tokens).
const PROMPT_BUDGET_CHARS = 80_000;
const DIR = join(homedir(), "talklore");
const ENTRY_TYPE = "talklore";

interface State {
	url: string;
	content: string;
	file: string;
	fetchedAt: number;
	expiresAt?: number;
	expired: boolean;
}

type FetchResult =
	| { kind: "ok"; content: string; expiresAt?: number }
	| { kind: "expired"; message: string }
	| { kind: "not-talklore" }
	| { kind: "error"; message: string };

function fileFor(url: string): string {
	// Per-link file name without putting the token itself on disk as a name.
	return join(DIR, `export-${createHash("sha256").update(url).digest("hex").slice(0, 12)}.md`);
}

// Never show the token: in notifications, errors, or tool results.
function redact(url: string): string {
	return url.replace(/\/export\/[^/?#]+/, "/export/…");
}

function parseExpiry(content: string): number | undefined {
	const m = content.match(/^Link expires:\s*(\S+)\s*$/m);
	const t = m ? Date.parse(m[1]) : NaN;
	return Number.isFinite(t) ? t : undefined;
}

function threadCount(content: string): number {
	return content.match(/^#### /gm)?.length ?? 0;
}

async function fetchExport(url: string, signal?: AbortSignal): Promise<FetchResult> {
	const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
	let response: Response;
	try {
		response = await fetch(url, {
			headers: { Accept: "text/markdown, text/plain;q=0.9, */*;q=0.1" },
			signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
		});
	} catch (e) {
		return { kind: "error", message: e instanceof Error ? e.message : String(e) };
	}
	const body = await response.text().catch(() => "");
	if (response.status === 410) {
		return { kind: "expired", message: body.trim() || "This Talklore link has expired." };
	}
	if (!response.ok) {
		// A 404 from something that isn't Talklore looks the same as a
		// replaced link; callers only report it when they know it's Talklore.
		return { kind: "error", message: `HTTP ${response.status}` };
	}
	if (!body.startsWith(MARKER)) return { kind: "not-talklore" };
	return { kind: "ok", content: body, expiresAt: parseExpiry(body) };
}

// Export v1 contract relied on here: line 1 is MARKER; a "Link expires: <ISO>"
// header line; "## " top-level sections (one is "## Glossary"); one "#### "
// heading per thread with a "Last touched:" line under it; nothing deeper.
// Keep the header and glossary whole; elsewhere only headings and
// "Last touched:" lines.
function condense(content: string): string {
	const out: string[] = [];
	let section = "header";
	for (const line of content.split("\n")) {
		if (line.startsWith("## ")) section = line.slice(3).trim().toLowerCase();
		if (section === "header" || section === "glossary" || line.startsWith("#") || line.startsWith("Last touched:")) {
			out.push(line);
		}
	}
	let text = out.join("\n");
	if (text.length > PROMPT_BUDGET_CHARS) {
		text = `${text.slice(0, PROMPT_BUDGET_CHARS)}\n\n[Cut off here; the rest is in the file.]`;
	}
	return text;
}

function renderSection(state: State): string {
	const full = state.content.length <= PROMPT_BUDGET_CHARS;
	const lines = [
		"The user has shared their Talklore export: what their Talklore voice agents remember about them, as topic threads with summaries and dates.",
		"Use it as private background to understand who they are, their projects, the people and places in their life, and their tastes, so you can tailor the work and skip questions it already answers.",
		"Don't recite it back, don't copy it into deliverables unless they ask, and never repeat or write down the link.",
		"The threads may be in another language; talk to the user in the language they use with you.",
		`Full copy: ${state.file} (fetched ${new Date(state.fetchedAt).toISOString()}).`,
	];
	if (state.expired) {
		lines.push(
			"The link has since expired, so this copy won't update. If fresher information matters, the user can make a new link in Talklore with \"Use with AI…\" and paste it here.",
		);
	}
	if (!full) {
		lines.push(
			`The export is large, so only the headings and dates are below. Read ${state.file} for the summaries of the threads that matter to the task.`,
		);
	}
	return `${lines.join("\n")}\n\n${full ? state.content : condense(state.content)}`;
}

export default function (pi: ExtensionAPI) {
	let state: State | undefined;
	// Link we last looked at, so a non-Talklore or dead link in the prompt
	// isn't re-fetched on every turn.
	let lastTried: string | undefined;
	// Tell the model about an expired/failed link once, on the turn it happened.
	let pendingNotice: string | undefined;

	function notify(ctx: ExtensionContext, message: string, type: "info" | "warning" | "error" = "info") {
		if (ctx.hasUI) ctx.ui.notify(message, type);
	}

	async function save(url: string, content: string, expiresAt: number | undefined): Promise<State> {
		const file = fileFor(url);
		await mkdir(DIR, { recursive: true, mode: 0o700 });
		await writeFile(file, content, { encoding: "utf8", mode: 0o600 });
		return { url, content, file, fetchedAt: Date.now(), expiresAt, expired: false };
	}

	// Load a link the user just gave. Returns a short, model-facing outcome.
	async function load(url: string, ctx: ExtensionContext, signal?: AbortSignal): Promise<string> {
		lastTried = url;
		const r = await fetchExport(url, signal);
		if (r.kind === "ok") {
			const isNew = state?.url !== url;
			state = await save(url, r.content, r.expiresAt);
			if (isNew) pi.appendEntry(ENTRY_TYPE, { url });
			const n = threadCount(r.content);
			notify(ctx, `Loaded your Talklore (${n} thread${n === 1 ? "" : "s"}).`);
			return `Loaded the Talklore export (${n} threads); it is in your system prompt as <talklore>.`;
		}
		if (r.kind === "expired") {
			notify(ctx, "That Talklore link has expired.", "warning");
			return `The Talklore link has expired (${r.message}). Ask the user to make a new one in Talklore with "Use with AI…" and paste it.`;
		}
		if (r.kind === "not-talklore") {
			return `${redact(url)} is not a Talklore export link.`;
		}
		return `Could not load ${redact(url)} (${r.message}). If the user meant it as a Talklore link, it may have been replaced by a newer one; they can make a fresh link in Talklore with "Use with AI…".`;
	}

	// Live: re-fetch a loaded link now and then while it's valid. Failures
	// keep the last good copy.
	async function refresh(ctx: ExtensionContext, signal?: AbortSignal, force = false): Promise<void> {
		if (!state || state.expired) return;
		if (!force && Date.now() - state.fetchedAt < REFRESH_MS) return;
		if (state.expiresAt && Date.now() > state.expiresAt) {
			state.expired = true;
			return;
		}
		const r = await fetchExport(state.url, signal);
		if (r.kind === "ok") {
			state = await save(state.url, r.content, r.expiresAt);
		} else if (r.kind === "expired") {
			state.expired = true;
			notify(ctx, "Your Talklore link has expired; using the last copy.", "warning");
		} else {
			// Try again later rather than on every turn.
			state.fetchedAt = Date.now();
		}
	}

	// Restore the link from the session (resume, fork, reload), using the
	// saved copy until the next refresh.
	pi.on("session_start", async (_event, ctx) => {
		state = undefined;
		lastTried = undefined;
		pendingNotice = undefined;
		let url: string | undefined;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === ENTRY_TYPE) {
				const u = (entry.data as { url?: unknown } | undefined)?.url;
				if (typeof u === "string") url = u;
			}
		}
		if (!url) return;
		lastTried = url;
		const file = fileFor(url);
		const content = await readFile(file, "utf8").catch(() => undefined);
		if (content?.startsWith(MARKER)) {
			// fetchedAt 0: refresh on the first turn if the link still works.
			state = { url, content, file, fetchedAt: 0, expiresAt: parseExpiry(content), expired: false };
		}
	});

	pi.on("before_agent_start", async (event, ctx) => {
		const link = event.prompt.match(LINK_RE)?.[0];
		if (link && link !== state?.url && link !== lastTried) {
			const outcome = await load(link, ctx, ctx.signal);
			// Only speak up about links that are (or were) Talklore links.
			if (!outcome.startsWith("Loaded") && !outcome.endsWith("is not a Talklore export link.")) {
				pendingNotice = outcome;
			}
		} else {
			await refresh(ctx, ctx.signal);
		}

		const sections = event.systemPromptOptions.sections;
		if (state) sections.talklore = renderSection(state);
		if (pendingNotice) {
			sections.talklore_notice = pendingNotice;
			pendingNotice = undefined;
		} else {
			delete sections.talklore_notice;
		}
	});

	pi.registerTool({
		name: "talklore_load",
		label: "Talklore",
		description:
			"Load (or refresh) the user's Talklore export: what their Talklore voice agents remember " +
			"about them. Talklore links pasted in the chat are loaded automatically; use this for a " +
			"link that wasn't picked up, or with no url to refresh the current one.",
		promptSnippet: "Load the user's Talklore memory from their export link",
		promptGuidelines: [
			"If the user mentions Talklore or pastes a link like https://…/export/… and there's no <talklore> section in your system prompt, call talklore_load with it.",
		],
		parameters: Type.Object({
			url: Type.Optional(Type.String({ description: "The Talklore export link (https://…/export/…). Omit to refresh the loaded one." })),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			let text: string;
			if (params.url) {
				const url = params.url.trim();
				if (!LINK_RE.test(url)) throw new Error("That doesn't look like a Talklore export link (https://…/export/…).");
				text = await load(url, ctx, signal);
			} else if (state) {
				await refresh(ctx, signal, true);
				text = state.expired
					? "The Talklore link has expired; the last copy stays in your system prompt."
					: `Refreshed the Talklore export (${threadCount(state.content)} threads).`;
			} else {
				throw new Error("No Talklore link loaded yet. Ask the user to paste one.");
			}
			return {
				content: [{ type: "text", text }],
				details: { loaded: !!state, threads: state ? threadCount(state.content) : 0, expired: state?.expired ?? false },
			};
		},
	});
}
