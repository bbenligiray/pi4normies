import { openAsBlob } from "node:fs";
import { basename } from "node:path";

// Voice messages → text with OpenRouter's speech-to-text endpoint, on the
// user's own key. https://openrouter.ai/docs/guides/overview/multimodal/stt
// Multipart uploads are capped at 25 MB, which is hours of Telegram voice
// (Opus); longer audio is better handled by the agent as a file.

export const TRANSCRIBE_MAX_BYTES = 25 * 1024 * 1024;

export async function transcribe(path: string, model: string, apiKey: string): Promise<string> {
	const form = new FormData();
	form.append("model", model);
	form.append("file", await openAsBlob(path), basename(path));
	const response = await fetch("https://openrouter.ai/api/v1/audio/transcriptions", {
		method: "POST",
		headers: { Authorization: `Bearer ${apiKey}` },
		body: form,
		signal: AbortSignal.timeout(120_000),
	});
	const body = await response.text();
	if (!response.ok) throw new Error(`HTTP ${response.status}: ${body.slice(0, 300)}`);
	const text = (JSON.parse(body) as { text?: unknown }).text;
	if (typeof text !== "string") throw new Error("no text in the response");
	return text.trim();
}
