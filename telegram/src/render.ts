import { type Token, type Tokens, lexer } from "marked";

// pi answers in Markdown; Telegram renders a small HTML subset
// (https://core.telegram.org/bots/api#html-style). Render from marked's
// tokens rather than with regexes, so the HTML is always well-formed, and
// split into messages at block boundaries to stay under Telegram's limit.

/** Telegram's limit is 4096 characters after entity parsing; leave headroom. */
export const MAX_MESSAGE = 4000;

export interface Chunk {
	html: string;
	/** Fallback if Telegram rejects the HTML anyway. */
	plain: string;
}

export function escapeHtml(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttr(text: string): string {
	return escapeHtml(text).replace(/"/g, "&quot;");
}

function safeHref(href: string): string | undefined {
	return /^(https?:|tg:|mailto:)/i.test(href.trim()) ? href.trim() : undefined;
}

function inline(tokens: Token[] | undefined): string {
	if (!tokens) return "";
	return tokens.map(inlineToken).join("");
}

function inlineToken(token: Token): string {
	switch (token.type) {
		case "text": {
			const t = token as Tokens.Text;
			return t.tokens ? inline(t.tokens) : escapeHtml(t.text);
		}
		case "escape":
			return escapeHtml((token as Tokens.Escape).text);
		case "strong":
			return `<b>${inline((token as Tokens.Strong).tokens)}</b>`;
		case "em":
			return `<i>${inline((token as Tokens.Em).tokens)}</i>`;
		case "del":
			return `<s>${inline((token as Tokens.Del).tokens)}</s>`;
		case "codespan":
			return `<code>${escapeHtml((token as Tokens.Codespan).text)}</code>`;
		case "br":
			return "\n";
		case "link": {
			const t = token as Tokens.Link;
			const label = inline(t.tokens);
			const href = safeHref(t.href);
			return href ? `<a href="${escapeAttr(href)}">${label}</a>` : label;
		}
		case "image": {
			const t = token as Tokens.Image;
			const href = safeHref(t.href);
			const label = escapeHtml(t.text || "image");
			return href ? `<a href="${escapeAttr(href)}">${label}</a>` : label;
		}
		case "checkbox":
			return (token as Tokens.Checkbox).checked ? "☑ " : "☐ ";
		default:
			return escapeHtml("raw" in token ? String(token.raw) : "");
	}
}

function cellText(cell: Tokens.TableCell): string {
	return cell.text.replace(/\s+/g, " ").trim();
}

function table(t: Tokens.Table): string {
	// Telegram has no tables; a monospaced grid is the most readable fallback.
	const rows = [t.header.map(cellText), ...t.rows.map((r) => r.map(cellText))];
	const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => (r[i] ?? "").length)));
	const line = (r: string[]) => r.map((c, i) => c.padEnd(widths[i])).join(" | ").trimEnd();
	const out = [line(rows[0]), widths.map((w) => "-".repeat(w)).join("-|-"), ...rows.slice(1).map(line)];
	return `<pre>${escapeHtml(out.join("\n"))}</pre>`;
}

function list(t: Tokens.List, depth: number): string {
	const indent = "  ".repeat(depth);
	const start = typeof t.start === "number" ? t.start : 1;
	return t.items
		.map((item, i) => {
			let bullet = t.ordered ? `${start + i}.` : "•";
			if (item.task) bullet = item.checked ? "☑" : "☐";
			// Nested lists indent themselves (depth + 1).
			const body = item.tokens
				.filter((tok) => tok.type !== "checkbox")
				.map((tok) => (tok.type === "list" ? list(tok as Tokens.List, depth + 1) : block(tok, depth + 1)))
				.filter((s) => s !== "")
				.join("\n");
			return `${indent}${bullet} ${body}`;
		})
		.join("\n");
}

function block(token: Token, depth = 0): string {
	switch (token.type) {
		case "space":
			return "";
		case "heading":
			return `<b>${inline((token as Tokens.Heading).tokens)}</b>`;
		case "paragraph":
			return inline((token as Tokens.Paragraph).tokens);
		case "text": {
			const t = token as Tokens.Text;
			return t.tokens ? inline(t.tokens) : escapeHtml(t.text);
		}
		case "code": {
			const t = token as Tokens.Code;
			const lang = t.lang?.match(/^[\w+-]+/)?.[0];
			const code = escapeHtml(t.text);
			return lang ? `<pre><code class="language-${lang}">${code}</code></pre>` : `<pre>${code}</pre>`;
		}
		case "blockquote": {
			const t = token as Tokens.Blockquote;
			return `<blockquote>${t.tokens.map((x) => block(x)).filter(Boolean).join("\n\n")}</blockquote>`;
		}
		case "list":
			return list(token as Tokens.List, depth);
		case "table":
			return table(token as Tokens.Table);
		case "hr":
			return "———";
		case "checkbox":
			return inlineToken(token);
		default:
			return escapeHtml("raw" in token ? String(token.raw).trim() : "");
	}
}

/** Split text into pieces of at most `max` characters, preferring line breaks. */
export function splitText(text: string, max: number): string[] {
	const out: string[] = [];
	let rest = text;
	while (rest.length > max) {
		let cut = rest.lastIndexOf("\n", max);
		if (cut < max / 2) cut = rest.lastIndexOf(" ", max);
		if (cut < max / 2) cut = max;
		out.push(rest.slice(0, cut));
		rest = rest.slice(cut).replace(/^\n/, "");
	}
	if (rest) out.push(rest);
	return out;
}

/** One block as pieces that each fit in a message. */
function blockPieces(token: Token): Chunk[] {
	const html = block(token);
	if (!html) return [];
	const plain = String(token.raw ?? "").trim();
	if (html.length <= MAX_MESSAGE) return [{ html, plain }];
	// Too long for one message: code stays code; anything else goes plain.
	if (token.type === "code") {
		const code = (token as Tokens.Code).text;
		return splitText(code, MAX_MESSAGE - 200).map((part) => ({ html: `<pre>${escapeHtml(part)}</pre>`, plain: part }));
	}
	return splitText(plain, MAX_MESSAGE - 200).map((part) => ({ html: escapeHtml(part), plain: part }));
}

/** Markdown → Telegram HTML messages, each within MAX_MESSAGE. */
export function renderMarkdown(markdown: string): Chunk[] {
	const pieces = lexer(markdown).flatMap(blockPieces);
	const chunks: Chunk[] = [];
	let current: Chunk | undefined;
	for (const piece of pieces) {
		if (current && current.html.length + 2 + piece.html.length <= MAX_MESSAGE) {
			current.html += `\n\n${piece.html}`;
			current.plain += `\n\n${piece.plain}`;
		} else {
			if (current) chunks.push(current);
			current = { ...piece };
		}
	}
	if (current) chunks.push(current);
	return chunks;
}
