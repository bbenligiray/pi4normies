import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Keep the images sent to the model within what the provider accepts.
//
// Every request carries the whole conversation, so images (screenshots, read
// images, photos the user sent) pile up: past ~30 MB of image data (or 100
// images) OpenRouter/Anthropic reject the request with a 413, and since the
// next request carries the same images, the session is stuck for good.
// Anthropic also caps the whole request at 32 MB, and images travel as
// base64 (4/3 of their size), so sizes here are base64 lengths, with room
// left for the text. Where pi's model catalog records lower limits for the
// current model (e.g. Google's 20 MB per request), those win.
//
// Before each model call, the oldest images are swapped for a short text note
// once the images exceed MAX_BYTES or MAX_COUNT, down to half of that.
// Images dropped once stay dropped (remembered by position), so the
// conversation prefix doesn't change on every new image, keeping the prompt
// cache useful. The session itself is untouched: only what's sent.

const MB = 1024 * 1024;
const MAX_BYTES = 16 * MB;
const MAX_COUNT = 50;

interface Limits {
	maxBytes: number;
	maxCount: number;
}

interface ModelLike {
	inputLimits?: { maxRequestBytes?: number; images?: { maxPerRequest?: number } };
}

/** Our limits, lowered to the model's own where the catalog has them. */
function limitsFor(model: ModelLike | undefined): Limits {
	const requestBytes = model?.inputLimits?.maxRequestBytes;
	const perRequest = model?.inputLimits?.images?.maxPerRequest;
	return {
		// Half the request for images, the rest for text.
		maxBytes: requestBytes ? Math.min(MAX_BYTES, Math.floor(requestBytes / 2)) : MAX_BYTES,
		maxCount: perRequest ? Math.min(MAX_COUNT, perRequest) : MAX_COUNT,
	};
}

interface Block {
	type: string;
	data?: string;
	mimeType?: string;
}

interface Message {
	role: string;
	timestamp?: number;
	content?: unknown;
}

interface ImageRef {
	key: string;
	bytes: number;
}

function keyOf(message: Message, index: number, block: number): string {
	return `${message.timestamp ?? `#${index}`}:${message.role}:${block}`;
}

export default function (pi: ExtensionAPI) {
	const dropped = new Set<string>();

	pi.on("session_start", () => dropped.clear());

	pi.on("context", (event, ctx) => {
		const { maxBytes, maxCount } = limitsFor(ctx.model as ModelLike | undefined);
		// Drop down to half, so drops come in batches rather than one per new image.
		const messages = event.messages as unknown as Message[];

		// Images still sent, oldest first.
		const kept: ImageRef[] = [];
		messages.forEach((message, i) => {
			if (!Array.isArray(message.content)) return;
			(message.content as Block[]).forEach((block, b) => {
				if (block?.type !== "image" || typeof block.data !== "string") return;
				const key = keyOf(message, i, b);
				if (!dropped.has(key)) kept.push({ key, bytes: block.data.length });
			});
		});

		let bytes = kept.reduce((sum, image) => sum + image.bytes, 0);
		let count = kept.length;
		if (bytes > maxBytes || count > maxCount) {
			// Never drop the newest image: it's what the model is looking at now.
			for (const image of kept.slice(0, -1)) {
				if (bytes <= maxBytes / 2 && count <= Math.floor(maxCount / 2)) break;
				dropped.add(image.key);
				bytes -= image.bytes;
				count--;
			}
		}
		if (dropped.size === 0) return;

		let changed = false;
		const out = messages.map((message, i) => {
			if (!Array.isArray(message.content)) return message;
			let touched = false;
			const content = (message.content as Block[]).map((block, b) => {
				if (block?.type !== "image" || !dropped.has(keyOf(message, i, b))) return block;
				touched = true;
				return {
					type: "text",
					text: "[An image was here. It was removed from the conversation to keep it within the AI service's size limit; open or screenshot it again if you need to see it.]",
				};
			});
			if (!touched) return message;
			changed = true;
			return { ...message, content };
		});
		if (changed) return { messages: out as unknown as typeof event.messages };
	});
}
