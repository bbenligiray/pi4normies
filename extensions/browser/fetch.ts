import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { formatSize } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
	chromeError,
	clampWait,
	DEFAULT_HEIGHT,
	DEFAULT_WAIT_MS,
	DEFAULT_WIDTH,
	MAX_WAIT_MS,
	normalizeUrl,
	runChrome,
	truncateToFile,
} from "./chrome.ts";

// web_fetch: read a URL the way a person would, as clean markdown.
//
// HTML is fetched directly first (fast). If that fails (blocked, error status)
// or yields almost no text (a JavaScript-rendered page), the page is rendered
// in headless Chrome instead. Readability extracts the main content, Turndown
// converts it to markdown. Non-HTML responses are handled by type: text is
// returned as-is, PDFs are converted with pdftotext when available, images are
// returned as images, and anything else is saved to disk for the agent to
// process with bash.

const FETCH_TIMEOUT_MS = 30_000;
const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
// Below this much extracted text, assume the page needs JavaScript.
const MIN_TEXT_CHARS = 300;
const DOWNLOAD_DIR = join(tmpdir(), "pi-web-fetch");

// A regular browser UA: many sites serve bot-ish clients an error or a stub.
// Others flag exactly this (a browser UA without a browser's TLS fingerprint),
// so blocked-looking responses are retried with Node's default UA.
const BROWSER_USER_AGENT =
	"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const BLOCKED_STATUSES = new Set([401, 403, 429, 503]);

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

interface Extracted {
	title: string;
	byline?: string;
	markdown: string;
	textChars: number;
}

function htmlToMarkdown(html: string, pageUrl: string, fullPage: boolean): Extracted {
	const { document } = parseHTML(html);

	// Absolute links, so the model can follow them. linkedom has no notion of
	// the document URL, so Readability can't do this itself.
	for (const [sel, attr] of [
		["a[href]", "href"],
		["img[src]", "src"],
	] as const) {
		for (const el of document.querySelectorAll(sel)) {
			try {
				el.setAttribute(attr, new URL(el.getAttribute(attr)!, pageUrl).href);
			} catch {}
		}
	}

	// Link tooltips just duplicate the link text in the markdown.
	for (const el of document.querySelectorAll("a[title]")) el.removeAttribute("title");

	let title = document.title?.trim() || "";
	let byline: string | undefined;
	let content: string | undefined;
	let textChars = 0;

	if (!fullPage) {
		try {
			// Readability mutates the document, so give it its own copy.
			const article = new Readability(parseHTML(document.toString()).document as any, {
				charThreshold: MIN_TEXT_CHARS,
			}).parse();
			const chars = article?.textContent?.trim().length ?? 0;
			if (article?.content && chars >= MIN_TEXT_CHARS) {
				content = article.content;
				title = article.title?.trim() || title;
				byline = article.byline?.trim() || undefined;
				textChars = chars;
			}
		} catch {
			// Fall through to the whole page.
		}
	}

	if (!content) {
		for (const el of document.querySelectorAll("script, style, noscript, template, svg, iframe, link, meta")) {
			el.remove();
		}
		const body = document.body ?? document.documentElement;
		content = body?.innerHTML ?? "";
		textChars = (body?.textContent ?? "").replace(/\s+/g, " ").trim().length;
	}

	const turndown = new TurndownService({
		headingStyle: "atx",
		codeBlockStyle: "fenced",
		bulletListMarker: "-",
	});
	turndown.remove(["script", "style", "noscript"] as any);
	const markdown = turndown
		.turndown(content)
		.replace(/\n{3,}/g, "\n\n")
		.trim();

	return { title, byline, markdown, textChars };
}

function safeFileName(url: string, contentType: string): string {
	let name = "";
	try {
		name = decodeURIComponent(basename(new URL(url).pathname));
	} catch {}
	name = name.replace(/[^\w.-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 100);
	if (!name) name = "download";
	if (!name.includes(".")) {
		const ext = contentType.split("/")[1]?.split(/[+;]/)[0];
		if (ext && /^[\w-]+$/.test(ext)) name += `.${ext}`;
	}
	return `${Date.now()}-${name}`;
}

async function saveDownload(url: string, contentType: string, body: Buffer): Promise<string> {
	await mkdir(DOWNLOAD_DIR, { recursive: true });
	const path = join(DOWNLOAD_DIR, safeFileName(url, contentType));
	await writeFile(path, body);
	return path;
}

async function fetchUrl(url: string, signal?: AbortSignal): Promise<Response> {
	let response: Response | undefined;
	for (const userAgent of [BROWSER_USER_AGENT, undefined]) {
		await response?.body?.cancel().catch(() => {});
		const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
		response = await fetch(url, {
			headers: {
				...(userAgent ? { "User-Agent": userAgent } : {}),
				Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
				"Accept-Language": "en-US,en;q=0.9",
			},
			redirect: "follow",
			signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
		});
		if (!BLOCKED_STATUSES.has(response.status)) break;
	}
	return response!;
}

async function renderWithChrome(
	pi: ExtensionAPI,
	url: string,
	waitMs: number,
	signal?: AbortSignal,
): Promise<{ html?: string; error?: string }> {
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
	if (html) return { html };
	return { error: `Chrome exited with code ${run.code} and rendered nothing. ${chromeError(run.stderr)}`.trim() };
}

export function registerWebFetch(pi: ExtensionAPI) {
	pi.registerTool({
		name: "web_fetch",
		label: "Web Fetch",
		description:
			"Read a web page as clean markdown: the main content (article, docs page, " +
			"product page, ...) with links made absolute. JavaScript-heavy pages are " +
			"rendered in headless Chrome automatically. Plain text/JSON is returned " +
			"as-is, PDFs are converted to text, images are returned as images, and " +
			"other files are downloaded to a temp path. Long results are truncated, " +
			"with the full content saved to a temp file.",
		promptSnippet: "Read a web page (or PDF/image/file URL) as clean markdown",
		promptGuidelines: [
			"Use web_fetch to read pages found with web_search or given by the user; use browser_screenshot when the visual layout matters.",
		],
		parameters: Type.Object({
			url: Type.String({ description: "URL to read, e.g. https://example.com/article or a local file:// URL." }),
			fullPage: Type.Optional(
				Type.Boolean({
					description:
						"Convert the whole page instead of extracting just the main content. Use when the extraction missed something (navigation, listings, tables in sidebars).",
				}),
			),
			waitMs: Type.Optional(
				Type.Integer({
					description: `If Chrome rendering is needed: virtual time budget for scripts to settle, in ms (default ${DEFAULT_WAIT_MS}).`,
					minimum: 0,
					maximum: MAX_WAIT_MS,
				}),
			),
		}),
		async execute(_toolCallId, params, signal, onUpdate) {
			const url = normalizeUrl(params.url);
			const fullPage = params.fullPage ?? false;
			const waitMs = clampWait(params.waitMs);
			const progress = (text: string) => onUpdate?.({ content: [{ type: "text", text }], details: {} });

			progress(`Fetching ${url}…`);

			let finalUrl = url;
			let html: string | undefined;
			let fetchProblem: string | undefined;

			if (/^https?:/i.test(url)) {
				let response: Response | undefined;
				try {
					response = await fetchUrl(url, signal);
				} catch (e) {
					if (signal?.aborted) throw e;
					fetchProblem = `direct request failed (${e instanceof Error ? e.message : String(e)})`;
				}

				if (response && !response.ok) {
					fetchProblem = `server returned ${response.status} ${response.statusText}`;
					await response.body?.cancel().catch(() => {});
				} else if (response) {
					finalUrl = response.url || url;
					const contentType = (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
					const length = Number(response.headers.get("content-length") ?? 0);

					if (!contentType || contentType.includes("html")) {
						html = await response.text();
					} else if (length > MAX_DOWNLOAD_BYTES) {
						await response.body?.cancel().catch(() => {});
						return {
							content: [
								{
									type: "text",
									text: `${finalUrl} is a ${contentType} file of ${formatSize(length)}, too large to fetch here. Download it with curl instead.`,
								},
							],
							details: { url, finalUrl, contentType, bytes: length },
						};
					} else {
						const body = Buffer.from(await response.arrayBuffer());
						return await handleNonHtml(pi, finalUrl, contentType, body, signal);
					}
				}
			}

			let extracted = html !== undefined ? htmlToMarkdown(html, finalUrl, fullPage) : undefined;
			let rendered = false;

			// Nothing usable from the direct request: render in Chrome, which also
			// handles file:// URLs, JavaScript apps, and many bot-blocking setups.
			if (!extracted || extracted.textChars < MIN_TEXT_CHARS) {
				progress(`Rendering ${finalUrl} in Chrome…`);
				const r = await renderWithChrome(pi, finalUrl, waitMs, signal);
				if (r.html) {
					const viaChrome = htmlToMarkdown(r.html, finalUrl, fullPage);
					if (!extracted || viaChrome.textChars > extracted.textChars) {
						extracted = viaChrome;
						rendered = true;
					}
				} else if (!extracted) {
					throw new Error(`web_fetch: could not load ${url}: ${[fetchProblem, r.error].filter(Boolean).join("; ")}`);
				}
			}

			// Readability often keeps the page's own <h1> title; don't repeat it.
			let markdown = extracted.markdown;
			if (extracted.title && markdown.startsWith(`# ${extracted.title}\n`)) {
				markdown = markdown.slice(extracted.title.length + 3).trimStart();
			}
			const header = [
				extracted.title ? `# ${extracted.title}` : undefined,
				`URL: ${finalUrl}`,
				extracted.byline ? `By: ${extracted.byline}` : undefined,
				fetchProblem && rendered ? `(Direct request: ${fetchProblem}; rendered in Chrome instead.)` : undefined,
			]
				.filter(Boolean)
				.join("\n");
			const body = markdown || "(The page has no readable text. Try browser_screenshot to see it.)";
			const out = await truncateToFile(`${header}\n\n${body}`, "page.md");

			return {
				content: [{ type: "text", text: out.text }],
				details: {
					url,
					finalUrl,
					title: extracted.title,
					rendered,
					fullPage,
					chars: extracted.markdown.length,
					truncated: out.truncated,
					fullOutputPath: out.fullOutputPath,
				},
			};
		},
	});
}

async function handleNonHtml(pi: ExtensionAPI, url: string, contentType: string, body: Buffer, signal?: AbortSignal) {
	const details = { url, finalUrl: url, contentType, bytes: body.byteLength } as Record<string, unknown>;

	if (
		contentType.startsWith("text/") ||
		/[/+](json|xml|javascript|ecmascript|yaml|csv|markdown)$/.test(contentType)
	) {
		const out = await truncateToFile(body.toString("utf8"), safeFileName(url, contentType));
		return {
			content: [{ type: "text" as const, text: `URL: ${url} (${contentType})\n\n${out.text}` }],
			details: { ...details, truncated: out.truncated, fullOutputPath: out.fullOutputPath },
		};
	}

	const path = await saveDownload(url, contentType, body);
	details.savedTo = path;
	const saved = `${url} (${contentType}, ${formatSize(body.byteLength)}) saved to ${path}.`;

	if (IMAGE_TYPES.has(contentType) && body.byteLength <= MAX_IMAGE_BYTES) {
		return {
			content: [
				{ type: "text" as const, text: saved },
				{ type: "image" as const, data: body.toString("base64"), mimeType: contentType },
			],
			details,
		};
	}

	if (contentType === "application/pdf") {
		let text = "";
		try {
			const r = await pi.exec("pdftotext", ["-layout", path, "-"], { signal, timeout: 60_000 });
			if (r.code === 0) text = r.stdout.trim();
		} catch {}
		if (text) {
			const out = await truncateToFile(text, "document.txt");
			return {
				content: [{ type: "text" as const, text: `${saved}\nText extracted with pdftotext:\n\n${out.text}` }],
				details: { ...details, truncated: out.truncated, fullOutputPath: out.fullOutputPath },
			};
		}
		return {
			content: [
				{
					type: "text" as const,
					text: `${saved}\nNo text could be extracted (scanned PDF, or pdftotext unavailable). Process the file with bash, or look at its pages as images.`,
				},
			],
			details,
		};
	}

	return {
		content: [{ type: "text" as const, text: `${saved}\nProcess it with bash as needed.` }],
		details,
	};
}
