import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type ReviewOutcome, Reviewer } from "./reviewer.ts";

const CONFIG_PATH = path.join(getAgentDir(), "review.json");
const DEFAULT_PROMPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "reviewer.md");
const TOOL_NAMES = ["request_review", "steer_review"];

interface Config {
  /** `provider/id[:thinking]` -> when to pick it. First entry is the default. */
  models: Record<string, string>;
  promptFile?: string;
  enabled: boolean;
}

function readRaw(): Record<string, any> {
  if (!fs.existsSync(CONFIG_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  } catch (e) {
    throw new Error(`Invalid ${CONFIG_PATH}: ${e}`);
  }
}

function loadConfig(): Config {
  const raw = readRaw();
  return { models: raw.models ?? {}, promptFile: raw.promptFile, enabled: raw.enabled ?? true };
}

function saveEnabled(enabled: boolean): void {
  fs.writeFileSync(CONFIG_PATH, `${JSON.stringify({ ...readRaw(), enabled }, null, 2)}\n`);
}

function modelDescription(config: Config): string {
  const entries = Object.entries(config.models);
  if (!entries.length) {
    return "Reviewer model as `provider/id`, optionally with `:thinking` (e.g. `openai/gpt-5:high`). Defaults to your own model.";
  }
  const menu = entries.map(([model, note], i) => `- \`${model}\`${i === 0 ? " (default)" : ""}: ${note}`).join("\n");
  return `Reviewer model. Pick the one that best fits the change:\n${menu}`;
}

function resolveModel(requested: string | undefined, config: Config, ctx: ExtensionContext): string {
  const configured = Object.keys(config.models);
  const spec = requested ?? configured[0] ?? (ctx.model && `${ctx.model.provider}/${ctx.model.id}`);
  if (!spec) throw new Error("No reviewer model: pass `model`.");
  if (configured.length && !configured.includes(spec)) {
    throw new Error(`Model ${spec} is not offered. Choose one of: ${configured.join(", ")}`);
  }
  const [ref] = spec.split(":");
  if (!ctx.modelRegistry.getAvailable().some((m) => `${m.provider}/${m.id}` === ref)) {
    throw new Error(`Model ${ref} is unknown or has no credentials.`);
  }
  return spec;
}

function outcomeMessage(reviewer: Reviewer, outcome: ReviewOutcome): string {
  const head = `Review ${reviewer.id} (${reviewer.model})`;
  if (outcome.kind === "failed") return `${head} failed: ${outcome.error}`;
  return (
    `${head} finished:\n\n${outcome.text}\n\n` +
    `Use steer_review with id ${reviewer.id} to dispute findings or to request a re-review after fixing them.`
  );
}

export default function (pi: ExtensionAPI) {
  const config = loadConfig();
  const promptFile = config.promptFile ?? DEFAULT_PROMPT;
  const reviewers = new Map<string, Reviewer>();
  let ui: ExtensionContext["ui"] | undefined;

  const updateStatus = () => {
    const running = [...reviewers.values()].filter((r) => r.running).map((r) => r.id);
    ui?.setStatus("review", running.length ? `reviewing: ${running.join(", ")}` : undefined);
  };

  const onOutcome = (reviewer: Reviewer, outcome: ReviewOutcome) => {
    updateStatus();
    pi.sendMessage(
      {
        customType: "review",
        content: outcomeMessage(reviewer, outcome),
        display: true,
        details: { id: reviewer.id, model: reviewer.model },
      },
      { triggerTurn: true, deliverAs: "steer" },
    );
  };

  pi.registerTool({
    name: "request_review",
    label: "Request Review",
    description:
      "Start a code review in the background. The reviewer runs on its own model with fresh context and read-only tools. " +
      "Returns a review id immediately; the review arrives later as a message. Keep working meanwhile, or end your turn " +
      "if there is nothing else to do: the result starts a new turn. Do not poll. " +
      "The reviewer cannot see this conversation, so state the goal, constraints, and scope (base ref, files).",
    promptSnippet: "Start a background code review by an independent reviewer model",
    parameters: Type.Object({
      request: Type.String({ description: "What changed and why, constraints, and what to review (base ref, files)." }),
      model: Type.Optional(Type.String({ description: modelDescription(config) })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      ui = ctx.ui;
      const model = resolveModel(params.model, config, ctx);
      const id = `R${reviewers.size + 1}`;
      const reviewer = new Reviewer({ id, model, cwd: ctx.cwd, promptFile, onOutcome });
      reviewers.set(id, reviewer);
      reviewer.send(params.request);
      updateStatus();
      return {
        content: [{ type: "text", text: `Review ${id} started with ${model}. Its result will arrive as a message.` }],
        details: { id, model },
      };
    },
  });

  pi.registerTool({
    name: "steer_review",
    label: "Steer Review",
    description:
      "Message a review started with request_review. While it runs, the message redirects it. After it finishes, the " +
      "message starts another round in the same reviewer context: dispute findings, answer its questions, or ask for a " +
      "re-review after fixes. Returns immediately; the reply arrives as a message.",
    promptSnippet: "Redirect a running review, or continue a finished one",
    parameters: Type.Object({
      id: Type.String({ description: "Review id from request_review, e.g. R1." }),
      message: Type.String(),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      ui = ctx.ui;
      const reviewer = reviewers.get(params.id);
      if (!reviewer) throw new Error(`No review ${params.id}. Known: ${[...reviewers.keys()].join(", ") || "none"}`);
      const wasRunning = reviewer.running;
      reviewer.send(params.message);
      updateStatus();
      const text = wasRunning ? `Steered review ${params.id}.` : `Started another round of review ${params.id}.`;
      return {
        content: [{ type: "text", text: `${text} The reply will arrive as a message.` }],
        details: { id: params.id },
      };
    },
  });

  const stopAll = () => {
    for (const reviewer of reviewers.values()) reviewer.stop();
    reviewers.clear();
    ui?.setStatus("review", undefined);
  };

  let enabled = config.enabled;
  const applyEnabled = () => {
    const others = pi.getActiveTools().filter((name) => !TOOL_NAMES.includes(name));
    pi.setActiveTools(enabled ? [...others, ...TOOL_NAMES] : others);
  };

  pi.registerCommand("review", {
    description: "Turn the review tools on or off (persists): /review [on|off]",
    handler: async (args, ctx) => {
      const arg = args.trim();
      if (arg && arg !== "on" && arg !== "off") return void ctx.ui.notify("Usage: /review [on|off]", "warning");
      enabled = arg ? arg === "on" : !enabled;
      saveEnabled(enabled);
      applyEnabled();
      if (!enabled) stopAll();
      ctx.ui.notify(`Review tools ${enabled ? "on" : "off"}`, "info");
    },
  });

  pi.on("session_start", applyEnabled);
  pi.on("session_shutdown", stopAll);
}
