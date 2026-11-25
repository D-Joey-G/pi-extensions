import { randomBytes } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const DEFAULT_MODEL = "openai/gpt-6.1-terra";
const READ_ONLY_TOOLS = ["read", "bash", "ffgrep", "fffind", "write", "intercom"];
// The child must always be able to write its report and signal the parent.
const REQUIRED_TOOLS = ["write", "intercom"];
// Pi's defaults plus intercom; no grandchildren.
const WRITABLE_TOOLS_SPEC = "+intercom,-agent";
const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const SCRATCH_ROOT = join(tmpdir(), "pi-agent-tab");
const FALLBACK_POLL_MS = 2000;

let modelsPromise: Promise<string[]> | undefined;

function listModels(pi: ExtensionAPI): Promise<string[]> {
  modelsPromise ??= pi.exec("pi", ["--list-models"], { timeout: 30_000 }).then((r) => {
    if (r.code !== 0) {
      modelsPromise = undefined;
      throw new Error(`pi --list-models failed (${r.code}): ${r.stderr.trim()}`);
    }
    return r.stdout
      .split("\n")
      .slice(1)
      .map((line) => line.trim().split(/\s+/))
      .filter((cols) => cols.length >= 2 && cols[0] && cols[1])
      .map(([provider, id]) => `${provider}/${id}`);
  });
  return modelsPromise;
}

function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = row;
  }
  return prev[b.length];
}

/** Returns the model argument for pi, resolved to `provider/id[:thinking]`. */
async function resolveModel(pi: ExtensionAPI, requested: string): Promise<string> {
  const colon = requested.lastIndexOf(":");
  const thinking = colon > 0 && THINKING_LEVELS.has(requested.slice(colon + 1)) ? requested.slice(colon) : "";
  const name = thinking ? requested.slice(0, colon) : requested;
  const models = await listModels(pi);
  const matches = models.filter((m) => m === name || m.slice(m.indexOf("/") + 1) === name);
  if (matches.length === 1) return matches[0] + thinking;
  const closest =
    matches.length > 1
      ? matches
      : models
          .map((m) => ({ m, d: Math.min(editDistance(name, m), editDistance(name, m.slice(m.indexOf("/") + 1))) }))
          .sort((x, y) => x.d - y.d)
          .slice(0, 5)
          .map((x) => x.m);
  const why = matches.length > 1 ? "is ambiguous" : "is not in `pi --list-models`";
  throw new Error(`Model "${name}" ${why}. Closest: ${closest.join(", ")}`);
}

function expandPath(base: string, path: string): string {
  return resolve(base, path.replace(/^~(?=$|\/)/, homedir()));
}

function makeLabel(task: string): string {
  const slug = task
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .slice(0, 3)
    .join("-")
    .slice(0, 24);
  return `${slug || "agent"}-${randomBytes(2).toString("hex")}`;
}

function buildBrief(o: {
  task: string;
  label: string;
  readOnly: boolean;
  reportPath: string;
  parentIntercomId: string | undefined;
}): string {
  const preamble = o.readOnly
    ? [
        `You are subagent "${o.label}", launched by another pi session. You are READ-ONLY:`,
        "do not create, edit or delete files and do not run state-changing commands",
        "(git commit/push, installs, rm, mv, network writes). The only file you may write is the report below.",
      ].join(" ")
    : `You are subagent "${o.label}", launched by another pi session.`;
  const signal = o.parentIntercomId
    ? [
        "2. Send the parent session one short intercom message, then nothing else:",
        `   intercom({ action: "send", to: "${o.parentIntercomId}", message: "Subagent ${o.label} finished. Report: ${o.reportPath}", noWake: false })`,
      ]
    : ["2. (The parent watches the report file; no message is needed.)"];
  const ask = o.parentIntercomId
    ? [
        "",
        `If you are blocked on a decision only the parent can make, use intercom({ action: "ask", to: "${o.parentIntercomId}", message: "..." }).`,
      ]
    : [];
  return [
    preamble,
    "",
    "## Task",
    "",
    o.task.trim(),
    "",
    "## Reporting back (required)",
    "",
    "When the task is done, or you cannot make progress:",
    `1. Write your final report as markdown to \`${o.reportPath}\` with the write tool. Write it once, complete.`,
    ...signal,
    "3. Stop. Do not wait for a reply or poll for anything.",
    ...ask,
    "",
  ].join("\n");
}

const outputSchema = Type.Object({
  blockId: Type.String(),
  label: Type.String(),
  reportPath: Type.String(),
  briefPath: Type.String(),
});

export default function (pi: ExtensionAPI) {
  const watchers = new Set<ReturnType<typeof setInterval>>();

  // Fallback completion signal when this session has no intercom identity.
  function watchReport(label: string, reportPath: string): void {
    let lastSize = -1;
    const timer = setInterval(() => {
      if (!existsSync(reportPath)) return;
      const size = statSync(reportPath).size;
      // Wait one extra poll for the size to settle.
      if (size === 0 || size !== lastSize) {
        lastSize = size;
        return;
      }
      clearInterval(timer);
      watchers.delete(timer);
      pi.sendMessage(
        {
          customType: "agent-tab",
          content: `Subagent ${label} finished. Report: ${reportPath}`,
          display: true,
          details: { label, reportPath },
        },
        { triggerTurn: true, deliverAs: "followUp" },
      );
    }, FALLBACK_POLL_MS);
    timer.unref?.();
    watchers.add(timer);
  }

  pi.on("session_shutdown", () => {
    for (const t of watchers) clearInterval(t);
    watchers.clear();
  });

  pi.registerTool(
    defineTool({
      name: "agent",
      label: "Agent",
      description:
        "Launch a subagent: a separate pi process in its own background Rex tab, briefed with `task`. Returns at once with the tab's blockId and the reportPath the subagent will write. When finished, the subagent writes a markdown report to reportPath and messages this session via intercom, which starts a new turn here. readOnly (default true) limits it to read,bash,ffgrep,fffind,write,intercom and tells it to change nothing but the report; readOnly=false gives pi's default tools plus intercom.",
      promptSnippet: "Launch a subagent (pi in a background Rex tab) that reports back via intercom",
      promptGuidelines: [
        "A subagent means the agent tool: a pi process in its own Rex tab. Give agent a self-contained task; the subagent sees none of this conversation.",
        "After calling agent, keep working or end your turn. Never sleep, poll, `rex wait` or read the report early: the subagent sends an intercom message naming reportPath when done, then read the report.",
      ],
      parameters: Type.Object({
        task: Type.String({
          description:
            "Complete, self-contained brief: goal, relevant paths, constraints, what the report must contain.",
        }),
        cwd: Type.String({ description: "Working directory for the subagent (absolute, ~ or relative to yours)." }),
        model: Type.Optional(
          Type.String({ description: `provider/id[:thinking] from pi --list-models. Default ${DEFAULT_MODEL}.` }),
        ),
        tools: Type.Optional(
          Type.Array(Type.String(), {
            description: "Exact tool allowlist, replacing the readOnly default. write and intercom are always added.",
          }),
        ),
        label: Type.Optional(
          Type.String({ description: "Tab label and session name. Default: derived from task, unique." }),
        ),
        readOnly: Type.Optional(Type.Boolean({ description: "Default true." })),
      }),
      outputSchema,
      async execute(_id, params, signal, _onUpdate, ctx) {
        const rexBlock = process.env.REX_BLOCK?.trim();
        if (!rexBlock) {
          throw new Error(
            "agent needs Rex: REX_BLOCK is not set, so this pi is not running in a Rex terminal. Start pi inside Rex.",
          );
        }
        const cwd = expandPath(ctx.cwd, params.cwd);
        if (!existsSync(cwd) || !statSync(cwd).isDirectory()) throw new Error(`cwd is not a directory: ${cwd}`);

        const model = await resolveModel(pi, params.model?.trim() || DEFAULT_MODEL);
        const readOnly = params.readOnly ?? true;
        const toolsArg = params.tools
          ? [...new Set([...params.tools, ...REQUIRED_TOOLS])].join(",")
          : readOnly
            ? READ_ONLY_TOOLS.join(",")
            : WRITABLE_TOOLS_SPEC;
        const label = params.label?.trim().replace(/\s+/g, "-") || makeLabel(params.task);

        await mkdir(SCRATCH_ROOT, { recursive: true });
        const dir = await mkdtemp(join(SCRATCH_ROOT, `${label.replace(/[^\w.-]/g, "_")}-`));
        const briefPath = join(dir, "brief.md");
        const reportPath = join(dir, "report.md");
        // pi-intercom publishes this session's routing ID here.
        const parentIntercomId = process.env.PI_INTERCOM_SESSION_ID?.trim() || undefined;
        await writeFile(briefPath, buildBrief({ task: params.task, label, readOnly, reportPath, parentIntercomId }));

        const rex = await pi.exec(
          "rex",
          [
            "run",
            "-s",
            rexBlock,
            "-c",
            cwd,
            "--label",
            label,
            "--keep-open",
            "--focus=false",
            "--json",
            "--",
            "pi",
            "--model",
            model,
            "--tools",
            toolsArg,
            "--name",
            label,
            // File reference: the brief never passes through a shell as text.
            `@${briefPath}`,
          ],
          { signal, timeout: 30_000 },
        );
        if (rex.code !== 0) throw new Error(`rex run failed (${rex.code}): ${(rex.stderr || rex.stdout).trim()}`);
        let blockId: string;
        try {
          blockId = JSON.parse(rex.stdout).block_ids[0];
        } catch {
          throw new Error(`Unexpected rex run output: ${rex.stdout.trim()}`);
        }
        if (!parentIntercomId) watchReport(label, reportPath);

        const out = { blockId, label, reportPath, briefPath };
        const how = parentIntercomId
          ? "It will send you an intercom message naming reportPath when done."
          : "This session has no intercom ID; the extension will post a message here when reportPath appears.";
        return {
          content: [
            {
              type: "text",
              text: `Launched subagent ${label} (${model}, ${readOnly ? "read-only" : "read-write"}) in Rex block ${blockId}.\nreportPath: ${reportPath}\nbriefPath: ${briefPath}\n${how} Keep working; do not sleep or poll.`,
            },
          ],
          structuredContent: out,
          details: out,
        };
      },
    }),
  );
}
