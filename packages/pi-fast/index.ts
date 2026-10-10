/**
 * Fast extension - send OpenAI requests with `service_tier: "priority"` (OpenAI "Fast mode").
 *
 *   /fast          toggle
 *   /fast on|off   set explicitly
 *
 * The setting persists across sessions in ~/.pi/agent/fast.json.
 *
 * Applies to the OpenAI providers only (Responses and Chat Completions APIs, plus the
 * ChatGPT/Codex backend). Fast mode bills a per-token premium over Standard processing.
 * See https://platform.openai.com/docs/guides/priority-processing
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const OPENAI_PROVIDERS = new Set(["openai", "openai-codex"]);
const STATE_FILE = join(homedir(), ".pi", "agent", "fast.json");

function loadEnabled(): boolean {
  if (!existsSync(STATE_FILE)) return false;
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8")).enabled === true;
  } catch {
    return false;
  }
}

export default function fastExtension(pi: ExtensionAPI) {
  let enabled = loadEnabled();

  const updateStatus = (ctx: ExtensionContext) => {
    ctx.ui.setStatus("fast", enabled ? "⚡ fast" : undefined);
  };

  pi.registerCommand("fast", {
    description: "Toggle OpenAI priority service tier (Fast mode)",
    getArgumentCompletions: (prefix) =>
      ["on", "off"].filter((v) => v.startsWith(prefix)).map((v) => ({ value: v, label: v })),
    handler: async (args, ctx) => {
      const arg = args.trim().toLowerCase();
      enabled = arg === "on" ? true : arg === "off" ? false : !enabled;
      writeFileSync(STATE_FILE, `${JSON.stringify({ enabled })}\n`);
      updateStatus(ctx);
      const applies = ctx.model && OPENAI_PROVIDERS.has(ctx.model.provider);
      ctx.ui.notify(
        enabled ? `Fast mode on${applies ? "" : " (applies once an OpenAI model is selected)"}` : "Fast mode off",
        "info",
      );
    },
  });

  pi.on("session_start", (_event, ctx) => updateStatus(ctx));

  pi.on("before_provider_request", (event, ctx) => {
    if (!enabled || !ctx.model || !OPENAI_PROVIDERS.has(ctx.model.provider)) return;
    const payload = event.payload;
    if (!payload || typeof payload !== "object") return;
    return { ...payload, service_tier: "priority" };
  });
}
