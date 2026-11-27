import { randomBytes } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineTool, getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  DEFAULT_MODEL,
  MODEL_ALIASES,
  describeModes,
  discoverModes,
  expandPath,
  findMode,
  modeDirs,
  resolveLaunch,
  resolveSkill,
  type ModeCatalog,
} from "./modes.ts";

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

function makeLabel(task: string, mode: string | undefined): string {
  const slug = task
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .slice(0, 3)
    .join("-")
    .slice(0, 24);
  // Mode first, so intercom lists read as "worker-fix-the-runner-1a2b".
  return [mode, slug || (mode ? "" : "agent"), randomBytes(2).toString("hex")].filter(Boolean).join("-");
}

function buildBrief(o: {
  task: string;
  label: string;
  readOnly: boolean;
  skillFiles: string[];
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
  const parent = o.parentIntercomId;
  const conduct = [
    "",
    "## Working as a subagent",
    "",
    "- The parent cannot see this tab. The report is your only output, so make it complete on its own.",
    "- Lead with the answer, back claims with `path:line` or the command and its output, and say what you verified versus inferred. Do not narrate your process.",
    ...(parent
      ? [
          `- Talk to the parent over intercom (target \`${parent}\`). If you are blocked on a decision only it can make, ask: intercom({ action: "ask", to: "${parent}", message: "..." }) and wait for the reply. Otherwise do not message it before the final report.`,
          "- The parent may message you mid-task to redirect you; follow its latest instruction.",
        ]
      : []),
  ];
  const skills = o.skillFiles.length
    ? ["", "Before starting, read these skills and follow them:", ...o.skillFiles.map((f) => `- ${f}`)]
    : [];
  return [
    preamble,
    ...skills,
    ...conduct,
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

  // Project modes are prompts and model choices from the repo, so they need project trust.
  function loadModes(ctx: ExtensionContext | undefined): ModeCatalog {
    return discoverModes(modeDirs(getAgentDir(), ctx?.isProjectTrusted() ? ctx.cwd : undefined));
  }

  function skillFiles(entries: string[], base: string): string[] {
    const known = new Map(
      pi
        .getCommands()
        .filter((c) => c.source === "skill")
        .map((c) => [c.name.replace(/^skill:/, ""), c.sourceInfo.path]),
    );
    return entries.map((e) => resolveSkill(e, base, known));
  }

  function registerAgentTool(catalog: ModeCatalog): void {
    const modes = describeModes(catalog);
    pi.registerTool(
      defineTool({
        name: "agent",
        label: "Agent",
        description: [
          "Launch a subagent: a separate pi process in its own background Rex tab, briefed with `task`. Returns at once with the tab's blockId and the reportPath the subagent will write. When finished, the subagent writes a markdown report to reportPath and messages this session via intercom, which starts a new turn here.",
          "A mode presets model, tools and a role prompt; explicit model, tools, readOnly and skills override it. Without a mode, readOnly (default true) limits it to read,bash,ffgrep,fffind,write,intercom and tells it to change nothing but the report; readOnly=false gives pi's default tools plus intercom.",
          ...(modes ? ["", "Modes:", modes] : []),
        ].join("\n"),
        promptSnippet: "Launch a subagent (pi in a background Rex tab) that reports back via intercom",
        promptGuidelines: [
          "A subagent means the agent tool: a pi process in its own Rex tab. Give agent a self-contained task; the subagent sees none of this conversation.",
          "Pick an agent mode when one fits the job (e.g. scout to find things, worker to change code, review to review it).",
          "After calling agent, keep working or end your turn. Never sleep, poll, `rex wait` or read the report early: the subagent sends an intercom message naming reportPath when done, then read the report.",
          "Talk to a running subagent with intercom, using its label as `to`: send to redirect it, and answer its asks with intercom reply.",
          `For "an opus worker" and the like, pass the mode plus a model alias: ${Object.keys(MODEL_ALIASES).join(", ")}.`,
        ],
        parameters: Type.Object({
          task: Type.String({
            description:
              "Complete, self-contained brief: goal, relevant paths, constraints, what the report must contain.",
          }),
          cwd: Type.String({ description: "Working directory for the subagent (absolute, ~ or relative to yours)." }),
          mode: Type.Optional(Type.String({ description: "Mode name from the list in this tool's description." })),
          model: Type.Optional(
            Type.String({
              description: `provider/id[:thinking] from pi --list-models, or an alias (${Object.entries(MODEL_ALIASES)
                .map(([a, m]) => `${a} = ${m}`)
                .join(", ")}), optionally with :thinking. Default: the mode's, else ${DEFAULT_MODEL}.`,
            }),
          ),
          tools: Type.Optional(
            Type.Array(Type.String(), {
              description: "Exact tool allowlist, replacing the readOnly default. write and intercom are always added.",
            }),
          ),
          skills: Type.Optional(
            Type.Array(Type.String(), {
              description: "Skill names or paths the subagent reads before starting. Replaces the mode's skills.",
            }),
          ),
          label: Type.Optional(
            Type.String({
              description:
                "Tab label and intercom session name. Default: mode plus the task's first words, made unique.",
            }),
          ),
          readOnly: Type.Optional(Type.Boolean({ description: "Default: the mode's, else true." })),
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

          // Re-read so mode edits apply without /reload.
          const mode = params.mode ? findMode(loadModes(ctx), params.mode.trim()) : undefined;
          const launch = resolveLaunch(params, mode);
          const model = await resolveModel(pi, launch.model);
          const skills = skillFiles(launch.skills, ctx.cwd);
          const label = params.label?.trim().replace(/\s+/g, "-") || makeLabel(params.task, mode?.name);

          await mkdir(SCRATCH_ROOT, { recursive: true });
          const dir = await mkdtemp(join(SCRATCH_ROOT, `${label.replace(/[^\w.-]/g, "_")}-`));
          const briefPath = join(dir, "brief.md");
          const reportPath = join(dir, "report.md");
          // pi-intercom publishes this session's routing ID here.
          const parentIntercomId = process.env.PI_INTERCOM_SESSION_ID?.trim() || undefined;
          await writeFile(
            briefPath,
            buildBrief({
              task: params.task,
              label,
              readOnly: launch.readOnly,
              skillFiles: skills,
              reportPath,
              parentIntercomId,
            }),
          );
          const piArgs = ["--model", model, "--tools", launch.tools, "--name", label];
          for (const skill of skills) piArgs.push("--skill", skill);
          if (launch.prompt) {
            const promptPath = join(dir, "mode.md");
            await writeFile(promptPath, launch.prompt);
            piArgs.push("--append-system-prompt", promptPath);
          }

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
              // Background agents yield CPU and I/O to the user's foreground work.
              ...(process.platform === "darwin" ? ["taskpolicy", "-c", "utility"] : []),
              "pi",
              ...piArgs,
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
          const desc = [mode && `mode ${mode.name}`, model, launch.readOnly ? "read-only" : "read-write"]
            .filter(Boolean)
            .join(", ");
          return {
            content: [
              {
                type: "text",
                text: `Launched subagent ${label} (${desc}) in Rex block ${blockId}.\nreportPath: ${reportPath}\nbriefPath: ${briefPath}\n${how} Keep working; do not sleep or poll.`,
              },
            ],
            structuredContent: out,
            details: out,
          };
        },
      }),
    );
  }

  registerAgentTool(loadModes(undefined));

  pi.on("session_start", (_event, ctx) => {
    const catalog = loadModes(ctx);
    registerAgentTool(catalog);
    if (catalog.problems.length) ctx.ui.notify(catalog.problems.join("\n"), "warning");
  });
}
