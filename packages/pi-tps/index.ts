/**
 * TPS extension - show output tokens per second for assistant responses.
 *
 * While streaming, the working message reads `Working - 42 T/s`, estimated from streamed
 * characters (~4 chars/token). When the message ends, the rate is recomputed from the
 * provider-reported `usage.output` and kept in the footer status.
 *
 * The clock starts at the first streamed content event, so time-to-first-token is excluded
 * and the figure reflects decode speed.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const CHARS_PER_TOKEN = 4;
const UPDATE_INTERVAL_MS = 250;

export default function tpsExtension(pi: ExtensionAPI) {
	let firstTokenAt: number | undefined;
	let streamedChars = 0;
	let lastUpdateAt = 0;

	const formatTps = (tps: number) => `${tps >= 100 ? Math.round(tps) : tps.toFixed(1)} T/s`;

	const reset = () => {
		firstTokenAt = undefined;
		streamedChars = 0;
		lastUpdateAt = 0;
	};

	pi.on("message_start", (event, ctx) => {
		if (event.message.role !== "assistant") return;
		reset();
		ctx.ui.setWorkingMessage();
	});

	pi.on("message_update", (event, ctx) => {
		const e = event.assistantMessageEvent;
		if (e.type === "start") return;
		const now = Date.now();
		firstTokenAt ??= now;
		if ("delta" in e) streamedChars += e.delta.length;

		const elapsed = (now - firstTokenAt) / 1000;
		if (elapsed < 0.5 || now - lastUpdateAt < UPDATE_INTERVAL_MS) return;
		lastUpdateAt = now;
		ctx.ui.setWorkingMessage(`Working - ${formatTps(streamedChars / CHARS_PER_TOKEN / elapsed)}`);
	});

	pi.on("message_end", (event, ctx) => {
		const message = event.message;
		if (message.role !== "assistant" || firstTokenAt === undefined) return;
		const elapsed = (Date.now() - firstTokenAt) / 1000;
		const tokens = message.usage?.output || streamedChars / CHARS_PER_TOKEN;
		if (elapsed > 0 && tokens > 0) {
			const label = formatTps(tokens / elapsed);
			ctx.ui.setWorkingMessage(`Working - ${label}`);
			ctx.ui.setStatus("tps", ctx.ui.theme.fg("dim", label));
		}
		reset();
	});

	pi.on("agent_end", (_event, ctx: ExtensionContext) => {
		ctx.ui.setWorkingMessage();
		reset();
	});
}
