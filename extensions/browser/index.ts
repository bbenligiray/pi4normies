import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import {
	chromeError,
	chromePath,
	clampWait,
	DEFAULT_HEIGHT,
	DEFAULT_WAIT_MS,
	DEFAULT_WIDTH,
	interestingStderr,
	MAX_WAIT_MS,
	normalizeUrl,
	runChrome,
	truncateToFile,
} from "./chrome.ts";
import { registerWebFetch } from "./fetch.ts";

// Browser tools backed by headless Chrome, so the agent can look at frontends
// (e.g. a dev server running on localhost inside the container) and read web
// pages.
//
//   browser_screenshot  render a URL and return a PNG screenshot
//   browser_dom         render a URL and return the serialized DOM after JS ran
//   web_fetch           read a URL as clean markdown (fetch.ts)
//
// Chrome is driven via its CLI directly (no puppeteer dependency), one fresh
// profile per call. pi resizes oversized images in tool results itself, so
// screenshots are returned as-is.
//
// Configuration (environment variables):
//   CHROME_PATH   optional - Chrome/Chromium binary
//                 (default: /usr/bin/google-chrome-stable, set in the Dockerfile)

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
					const err = chromeError(run.stderr);
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
			"inspecting markup. To read a page's text content, prefer web_fetch. " +
			"Large DOMs are truncated; the full HTML is saved to a temp file.",
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

			const html = run.stdout.trim();
			if (!html) {
				const err = chromeError(run.stderr);
				throw new Error(
					`browser_dom: Chrome (${chromePath()}) exited with code ${run.code} and produced no DOM for ${url}.` +
						(err ? `\n${err}` : ""),
				);
			}

			const out = await truncateToFile(html, "dom.html");
			let text = `DOM of ${url}:\n\n${out.text}`;
			const err = interestingStderr(run.stderr);
			if (err) text += `\n\nChrome reported:\n${err}`;

			return {
				content: [{ type: "text", text }],
				details: { url, waitMs, truncated: out.truncated, fullOutputPath: out.fullOutputPath, chars: html.length },
			};
		},
	});

	registerWebFetch(pi);
}
