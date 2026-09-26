import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateHead } from "@earendil-works/pi-coding-agent";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Shared helpers for the browser tools: running headless Chrome, URL
// normalization, and truncating large results.

const DEFAULT_CHROME = "/usr/bin/google-chrome-stable";
export const DEFAULT_WIDTH = 1280;
export const DEFAULT_HEIGHT = 800;
export const DEFAULT_WAIT_MS = 3000;
export const MAX_WAIT_MS = 30_000;
const EXEC_TIMEOUT_MS = 60_000;

export function chromePath(): string {
	return process.env.CHROME_PATH || DEFAULT_CHROME;
}

export function normalizeUrl(url: string): string {
	url = url.trim();
	// Bare paths are almost certainly local files the agent wants to preview.
	if (url.startsWith("/")) return `file://${url}`;
	// host:port (e.g. "localhost:5173/x") would otherwise parse as a URL with
	// scheme "localhost".
	if (/^[\w.-]+:\d+(?:[/?#]|$)/.test(url)) return `http://${url}`;
	if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) return `http://${url}`;
	return url;
}

export function clampWait(ms: number | undefined): number {
	const v = ms ?? DEFAULT_WAIT_MS;
	return Math.max(0, Math.min(MAX_WAIT_MS, Math.floor(v)));
}

export interface ChromeRunOptions {
	url: string;
	width: number;
	height: number;
	waitMs: number;
	extraArgs: string[];
	signal?: AbortSignal;
}

// Run headless Chrome once. Returns stdout and the temporary directory the
// process ran in (its cwd, where --screenshot writes); the caller must clean
// it up.
export async function runChrome(
	pi: ExtensionAPI,
	opts: ChromeRunOptions,
): Promise<{ stdout: string; stderr: string; code: number; dir: string }> {
	const dir = await mkdtemp(join(tmpdir(), "pi-browser-"));
	const args = [
		"--headless=new",
		// The container typically runs without the kernel features Chrome's
		// sandbox needs; this is a dev container, so trade it for reliability.
		"--no-sandbox",
		"--disable-gpu",
		// Docker's default /dev/shm is tiny; fall back to /tmp for shared memory.
		"--disable-dev-shm-usage",
		"--hide-scrollbars",
		"--force-device-scale-factor=1",
		"--no-first-run",
		"--no-default-browser-check",
		"--disable-extensions",
		`--user-data-dir=${join(dir, "profile")}`,
		`--window-size=${opts.width},${opts.height}`,
		// Advances virtual time so timers/animations/fetches in SPAs settle
		// before capture, without literally sleeping that long.
		`--virtual-time-budget=${opts.waitMs}`,
		...opts.extraArgs,
		opts.url,
	];
	const result = await pi.exec(chromePath(), args, {
		cwd: dir,
		signal: opts.signal,
		timeout: EXEC_TIMEOUT_MS,
	});
	return { stdout: result.stdout, stderr: result.stderr, code: result.code, dir };
}

// Chrome is chatty on stderr even on success; keep only lines that look like
// actual problems so the model isn't distracted by dbus/GPU noise.
export function interestingStderr(stderr: string): string {
	return stderr
		.split("\n")
		.filter((l) => /ERR_|FATAL|Failed to|cannot|not found|No such/i.test(l))
		.filter((l) => !/dbus|DBus|gpu|GPU|vaapi|sandbox|fontconfig/i.test(l))
		.slice(0, 10)
		.join("\n")
		.trim();
}

// Last few stderr lines, for error messages when Chrome produced nothing.
export function chromeError(stderr: string): string {
	return interestingStderr(stderr) || stderr.trim().split("\n").slice(-5).join("\n");
}

// Cap model-facing text at pi's standard limits. If it's cut, the full text
// is written to a temp file and the model is told where to read the rest.
export async function truncateToFile(
	text: string,
	fileName: string,
): Promise<{ text: string; truncated: boolean; fullOutputPath?: string }> {
	const t = truncateHead(text, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
	if (!t.truncated) return { text, truncated: false };
	const dir = await mkdtemp(join(tmpdir(), "pi-browser-out-"));
	const path = join(dir, fileName);
	await writeFile(path, text, "utf8");
	// truncateHead only keeps whole lines, so a huge first line (minified
	// HTML) yields nothing; fall back to a plain character cut then.
	const shown = t.firstLineExceedsLimit ? text.slice(0, DEFAULT_MAX_BYTES / 2) : t.content;
	const note =
		`\n\n[Truncated: showing ${formatSize(Buffer.byteLength(shown))} of ${formatSize(t.totalBytes)} ` +
		`(${t.totalLines} lines in total). ` +
		`Full content saved to ${path}; use read with offset/limit to see the rest.]`;
	return { text: shown + note, truncated: true, fullOutputPath: path };
}
