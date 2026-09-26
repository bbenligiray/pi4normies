import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// Web search tool backed by Perplexity's Sonar models via OpenRouter.
//
// Configuration (environment variables):
//   OPENROUTER_API_KEY   required - your OpenRouter API key
//   PI_WEBSEARCH_MODEL   optional - OpenRouter model id
//                        (default: "perplexity/sonar")
//
// Perplexity models perform a live web search and return an answer with
// citations, which we surface back to the LLM.

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const DEFAULT_MODEL = "perplexity/sonar";
const REQUEST_TIMEOUT_MS = 60_000;

interface UrlCitation {
	type: string;
	url_citation?: { url?: string; title?: string };
}

interface OpenRouterMessage {
	role: string;
	content: string;
	// Perplexity models expose their sources here, as url_citation annotations.
	annotations?: UrlCitation[];
}

interface OpenRouterResponse {
	choices?: Array<{ message?: OpenRouterMessage }>;
	// Some providers/models return a flat citations array at the top level.
	citations?: string[];
	error?: { message?: string };
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "web_search",
		label: "Web Search",
		description:
			"Search the web for current information using Perplexity (via OpenRouter). " +
			"Returns a synthesized answer with source citations. Use this for questions " +
			"about recent events, documentation, library versions, or anything that may be " +
			"newer than your training data.",
		promptSnippet: "Search the web for up-to-date information with citations",
		promptGuidelines: [
			"Use web_search when the user asks about current events, recent releases, or facts that may have changed after your training cutoff.",
		],
		parameters: Type.Object({
			query: Type.String({
				description: "The search query or question to research on the web.",
			}),
		}),
		async execute(_toolCallId, params, signal, onUpdate, _ctx) {
			const apiKey = process.env.OPENROUTER_API_KEY;
			if (!apiKey) {
				throw new Error(
					"web_search is not configured: set the OPENROUTER_API_KEY environment variable.",
				);
			}

			const model = process.env.PI_WEBSEARCH_MODEL || DEFAULT_MODEL;

			onUpdate?.({ content: [{ type: "text", text: `Searching the web: ${params.query}` }] });

			// Honor both the agent's abort signal and a hard timeout.
			const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
			const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

			let response: Response;
			try {
				response = await fetch(OPENROUTER_URL, {
					method: "POST",
					headers: {
						Authorization: `Bearer ${apiKey}`,
						"Content-Type": "application/json",
						// Optional attribution headers recommended by OpenRouter.
						"HTTP-Referer": "https://pi.dev",
						"X-Title": "pi web_search",
					},
					body: JSON.stringify({
						model,
						messages: [{ role: "user", content: params.query }],
					}),
					signal: combined,
				});
			} catch (e) {
				const message = e instanceof Error ? e.message : String(e);
				throw new Error(`web_search request failed: ${message}`);
			}

			if (!response.ok) {
				const body = await response.text().catch(() => "");
				throw new Error(
					`web_search failed: OpenRouter returned ${response.status} ${response.statusText}. ${body}`.trim(),
				);
			}

			const data = (await response.json()) as OpenRouterResponse;
			if (data.error) {
				throw new Error(`web_search error: ${data.error.message ?? "unknown error"}`);
			}

			const message = data.choices?.[0]?.message;
			const answer = message?.content?.trim() ?? "";

			// Prefer url_citation annotations (Perplexity via OpenRouter); fall back
			// to a top-level citations array if a provider returns that shape instead.
			const annotationUrls = (message?.annotations ?? [])
				.filter((a) => a.type === "url_citation" && a.url_citation?.url)
				.map((a) => ({ url: a.url_citation!.url!, title: a.url_citation?.title }));
			const citations =
				annotationUrls.length > 0
					? annotationUrls
					: (data.citations ?? []).map((url) => ({ url, title: undefined as string | undefined }));

			if (!answer) {
				throw new Error("web_search returned no answer.");
			}

			let text = answer;
			if (citations.length > 0) {
				const sources = citations
					.map((c, i) => `[${i + 1}] ${c.title ? `${c.title} — ${c.url}` : c.url}`)
				.join("\n");
				text += `\n\nSources:\n${sources}`;
			}

			return {
				content: [{ type: "text", text }],
				details: { model, query: params.query, citations: citations.map((c) => c.url) },
			};
		},
	});
}
