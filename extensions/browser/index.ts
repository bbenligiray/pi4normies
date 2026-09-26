import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Browser tools backed by headless Chrome, so the agent can look at frontends
// (e.g. a dev server running on localhost inside the container).
//
//   browser_screenshot  render a URL and return a PNG screenshot
//   browser_dom         render a URL and return the serialized DOM after JS ran
//
// Both drive the Chrome CLI directly (no puppeteer dependency), one fresh
// profile per call. pi resizes oversized images in tool results itself, so
// screenshots are returned as-is.
//
// Configuration (environment variables):
//   CHROME_PATH   optional - Chrome/Chromium binary
//                 (default: /usr/bin/google-chrome-stable, set in the Dockerfile)

const DEFAULT_CHROME = "/usr/bin/google-chrome-stable";
const DEFAULT_WIDTH = 1280;
const DEFAULT_HEIGHT = 800;
const DEFAULT_WAIT_MS = 3000;
const MAX_WAIT_MS = 30_000;
const EXEC_TIMEOUT_MS = 60_000;
const MAX_DOM_CHARS = 100_000;

function chromePath(): string {
	return process.env.CHROME_PATH || DEFAULT_CHROME;
}

function normalizeUrl(url: string): string {
	// Bare paths are almost certainly local files the agent wants to preview.
	if (url.startsWith("/")) return `file://${url}`;
	if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) return `http://${url}`;
	return url;
}

function clampWait(ms: number | undefined): number {
	const v = ms ?? DEFAULT_WAIT_MS;
	return Math.max(0, Math.min(MAX_WAIT_MS, Math.floor(v)));
}

interface ChromeRunOptions {
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
async function runChrome(
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
function interestingStderr(stderr: string): string {
	return stderr
		.split("\n")
		.filter((l) => /ERR_|FATAL|Failed to|cannot|not found|No such/i.test(l))
		.filter((l) => !/dbus|DBus|gpu|GPU|vaapi|sandbox|fontconfig/i.test(l))
		.slice(0, 10)
		.join("\n")
		.trim();
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "browser_screenshot",
		label: "Browser Screenshot",
		description:
			"Render a web page in headless Chrome and return a PNG screenshot. " +
			"Use it to visually verify frontends: dev servers on localhost, local HTML " +
			"files (absolute paths or file:// URLs), or public sites. Only the viewport " +
			"is captured; raise `height` to see more of a long page.",
		promptSnippet: "Screenshot a URL or local HTML file with headless Chrome",
		promptGuidelines: [
			"Use browser_screenshot to look at a frontend after changing UI code; start the dev server with bash first (in the background) and screenshot its localhost URL.",
		],
		parameters: Type.Object({
			url: Type.String({
				description:
					"URL to render, e.g. http://localhost:5173/, /abs/path/page.html or file:///abs/path/page.html.",
			}),
			width: Type.Optional(
				Type.Integer({ description: `Viewport width in px (default ${DEFAULT_WIDTH}).`, minimum: 200, maximum: 4000 }),
			),
			height: Type.Optional(
				Type.Integer({ description: `Viewport height in px (default ${DEFAULT_HEIGHT}).`, minimum: 200, maximum: 8000 }),
			),
			waitMs: Type.Optional(
				Type.Integer({
					description: `Virtual time budget for scripts/animations to settle before capture, in ms (default ${DEFAULT_WAIT_MS}, max ${MAX_WAIT_MS}).`,
					minimum: 0,
					maximum: MAX_WAIT_MS,
				}),
			),
		}),
		async execute(_toolCallId, params, signal, onUpdate) {
			const url = normalizeUrl(params.url);
			const width = params.width ?? DEFAULT_WIDTH;
			const height = params.height ?? DEFAULT_HEIGHT;
			const waitMs = clampWait(params.waitMs);

			onUpdate?.({ content: [{ type: "text", text: `Rendering ${url} at ${width}x${height}…` }], details: {} });

			const run = await runChrome(pi, {
				url,
				width,
				height,
				waitMs,
				extraArgs: ["--screenshot=screenshot.png"],
				signal,
			});
			try {
				let png: Buffer;
				try {
					png = await readFile(join(run.dir, "screenshot.png"));
				} catch {
					const err = interestingStderr(run.stderr) || run.stderr.trim().split("\n").slice(-5).join("\n");
					throw new Error(
						`browser_screenshot: Chrome (${chromePath()}) exited with code ${run.code} and produced no screenshot for ${url}.` +
							(err ? `\n${err}` : ""),
					);
				}

				const notes = [`Screenshot of ${url} (${width}x${height})`];
				const err = interestingStderr(run.stderr);
				if (err) notes.push(`Chrome reported:\n${err}`);

				return {
					content: [
						{ type: "text", text: notes.join("\n") },
						{ type: "image", data: png.toString("base64"), mimeType: "image/png" },
					],
					details: { url, width, height, waitMs, bytes: png.byteLength },
				};
			} finally {
				await rm(run.dir, { recursive: true, force: true }).catch(() => {});
			}
		},
	});

	pi.registerTool({
		name: "browser_dom",
		label: "Browser DOM",
		description:
			"Render a web page in headless Chrome (JavaScript executed) and return the " +
			"resulting HTML. Useful for checking what a SPA actually rendered, or " +
			"reading text/links when a screenshot is not enough.",
		promptSnippet: "Get the JS-rendered HTML of a URL with headless Chrome",
		parameters: Type.Object({
			url: Type.String({ description: "URL to render (same forms as browser_screenshot)." }),
			waitMs: Type.Optional(
				Type.Integer({
					description: `Virtual time budget for scripts to settle, in ms (default ${DEFAULT_WAIT_MS}).`,
					minimum: 0,
					maximum: MAX_WAIT_MS,
				}),
			),
		}),
		async execute(_toolCallId, params, signal, onUpdate) {
			const url = normalizeUrl(params.url);
			const waitMs = clampWait(params.waitMs);

			onUpdate?.({ content: [{ type: "text", text: `Rendering ${url}…` }], details: {} });

			const run = await runChrome(pi, {
				url,
				width: DEFAULT_WIDTH,
				height: DEFAULT_HEIGHT,
				waitMs,
				extraArgs: ["--dump-dom"],
				signal,
			});
			await rm(run.dir, { recursive: true, force: true }).catch(() => {});

			let html = run.stdout.trim();
			if (!html) {
				const err = interestingStderr(run.stderr) || run.stderr.trim().split("\n").slice(-5).join("\n");
				throw new Error(
					`browser_dom: Chrome (${chromePath()}) exited with code ${run.code} and produced no DOM for ${url}.` +
						(err ? `\n${err}` : ""),
				);
			}

			let truncated = false;
			if (html.length > MAX_DOM_CHARS) {
				html = html.slice(0, MAX_DOM_CHARS);
				truncated = true;
			}

			let text = `DOM of ${url}${truncated ? ` (truncated to ${MAX_DOM_CHARS} chars)` : ""}:\n\n${html}`;
			const err = interestingStderr(run.stderr);
			if (err) text += `\n\nChrome reported:\n${err}`;

			return {
				content: [{ type: "text", text }],
				details: { url, waitMs, truncated, chars: html.length },
			};
		},
	});
}
