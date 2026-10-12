import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

const CONFIG_PATH = path.join(os.homedir(), ".pi", "agent", "ai-pair.json");
const REVIEWER_TOOL = path.join(path.dirname(fileURLToPath(import.meta.url)), "reviewer-tool.ts");
const DEFAULT_ROUNDS = 3;

interface Finding {
  id: string;
  severity: string;
  file?: string;
  issue: string;
  suggestion?: string;
  note?: string;
}
interface Verdict {
  verdict: "approve" | "changes_requested";
  summary: string;
  findings: Finding[];
  resolved: { id: string; note?: string }[];
}
interface TurnResult {
  text: string;
  aborted: boolean;
  error?: string;
}
interface RoundLog {
  round: number;
  implementer: string;
  verdict: Verdict;
}

const REVIEWER_SYSTEM = `You are the reviewer in an implementer/reviewer pair. Another model implements; you critique. Do NOT edit project files.
- Put any scratch files under the scratch dir given in the prompt.
- Review the diff against the plan: correctness, missed requirements, edge cases, tests, regressions, scope creep. Run tests/lint/typecheck when useful.
- Prioritise real defects over style. Don't invent issues; nits are non-blocking.
- On later rounds, re-verify every prior finding against the code. If the implementer disputed a finding, judge the rationale: accept it (put the id in "resolved") or reject it (keep it in "findings" with a "note").
- Finish by calling submit_review exactly once. Use "approve" only when nothing blocking remains.`;

function loadConfig(): { implementer?: string; reviewer?: string } {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  } catch {
    return {};
  }
}

function parseArgs(raw: string) {
  let rounds = DEFAULT_ROUNDS;
  let confirmPlan = false;
  const rest: string[] = [];
  const tokens = raw.split(/\s+/).filter(Boolean);
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === "--confirm-plan") confirmPlan = true;
    else if (tokens[i] === "--rounds" && Number(tokens[i + 1]) > 0) rounds = Number(tokens[++i]);
    else rest.push(tokens[i]);
  }
  return { rounds, confirmPlan, task: rest.join(" ") };
}

async function git(pi: ExtensionAPI, cwd: string, ...args: string[]) {
  const r = await pi.exec("git", args, { cwd });
  return { ok: r.code === 0, out: r.stdout.trim() };
}

function formatFindings(findings: Finding[]): string {
  return findings
    .map(
      (f) =>
        `- [${f.id}] (${f.severity})${f.file ? ` ${f.file}` : ""}: ${f.issue}` +
        (f.suggestion ? `\n  Suggestion: ${f.suggestion}` : "") +
        (f.note ? `\n  Reviewer note: ${f.note}` : ""),
    )
    .join("\n");
}

function lastAssistant(ctx: ExtensionCommandContext): TurnResult {
  const branch = ctx.sessionManager.getBranch();
  for (let i = branch.length - 1; i >= 0; i--) {
    const e = branch[i];
    if (e.type !== "message" || e.message.role !== "assistant") continue;
    const m = e.message as any;
    const text = (m.content as any[])
      .filter((p) => p.type === "text")
      .map((p) => p.text)
      .join("\n")
      .trim();
    return {
      text,
      aborted: m.stopReason === "aborted",
      error: m.stopReason === "error" ? (m.errorMessage ?? "model error") : undefined,
    };
  }
  return { text: "", aborted: false, error: "no assistant response" };
}

function piInvocation(args: string[]): { command: string; args: string[] } {
  const script = process.argv[1];
  if (script && !script.startsWith("/$bunfs/root/") && fs.existsSync(script)) {
    return { command: process.execPath, args: [script, ...args] };
  }
  return { command: "pi", args };
}

async function runReviewer(opts: {
  cwd: string;
  model: string;
  sessionFile: string;
  systemFile: string;
  prompt: string;
  signal: AbortSignal;
  onActivity: (s: string) => void;
}): Promise<{ verdict?: Verdict; text: string; stderr: string; aborted: boolean }> {
  const args = [
    "--mode",
    "json",
    "-p",
    "--session",
    opts.sessionFile,
    "--model",
    opts.model,
    "-e",
    REVIEWER_TOOL,
    "--append-system-prompt",
    opts.systemFile,
    opts.prompt,
  ];
  const inv = piInvocation(args);
  return new Promise((resolve) => {
    const proc = spawn(inv.command, inv.args, { cwd: opts.cwd, stdio: ["ignore", "pipe", "pipe"] });
    let verdict: Verdict | undefined;
    let text = "";
    let stderr = "";
    let buf = "";
    let aborted = false;

    const onLine = (line: string) => {
      let ev: any;
      try {
        ev = JSON.parse(line);
      } catch {
        return;
      }
      if (ev.type === "tool_execution_start") opts.onActivity(ev.toolName);
      if (ev.type === "tool_execution_end" && ev.toolName === "submit_review" && !ev.isError) {
        verdict = ev.result?.details as Verdict;
      }
      if (ev.type === "message_end" && ev.message?.role === "assistant") {
        const t = (ev.message.content as any[])
          .filter((p) => p.type === "text")
          .map((p) => p.text)
          .join("\n")
          .trim();
        if (t) text = t;
      }
    };
    proc.stdout.on("data", (d) => {
      buf += d.toString();
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      lines.forEach(onLine);
    });
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("close", () => {
      if (buf.trim()) onLine(buf);
      resolve({ verdict, text, stderr, aborted });
    });
    proc.on("error", (e) => {
      stderr += String(e);
      resolve({ verdict, text, stderr, aborted });
    });

    const kill = () => {
      aborted = true;
      proc.kill("SIGTERM");
      setTimeout(() => proc.killed || proc.kill("SIGKILL"), 5000);
    };
    if (opts.signal.aborted) kill();
    else opts.signal.addEventListener("abort", kill, { once: true });
  });
}

export default function (pi: ExtensionAPI) {
  function runImplementerTurn(ctx: ExtensionCommandContext, prompt: string): Promise<TurnResult> {
    return new Promise((resolve) => {
      let started = false;
      const offStart = pi.on("agent_start", () => {
        started = true;
      });
      const offSettled = pi.on("agent_settled", () => {
        if (!started) return;
        offStart();
        offSettled();
        resolve(lastAssistant(ctx));
      });
      pi.sendUserMessage(prompt);
    });
  }

  let running = false;

  pi.registerCommand("ai-pair", {
    description: "One model implements, another reviews, up to N rounds. Flags: --rounds N, --confirm-plan",
    handler: async (rawArgs, ctx) => {
      if (running) return void ctx.ui.notify("ai-pair already running", "warning");
      if (!ctx.hasUI) return void ctx.ui.notify("ai-pair needs an interactive session", "error");
      if (!ctx.isIdle()) return void ctx.ui.notify("Agent is busy", "warning");

      const { rounds: initialRounds, confirmPlan, task } = parseArgs(rawArgs);
      const root = await git(pi, ctx.cwd, "rev-parse", "--show-toplevel");
      if (!root.ok) return void ctx.ui.notify("ai-pair requires a git repo", "error");

      const models = ctx.scopedModels.length ? ctx.scopedModels.map((s) => s.model) : ctx.modelRegistry.getAvailable();
      const label = (m: { provider: string; id: string }) => `${m.provider}/${m.id}`;
      const byLabel = new Map(models.map((m) => [label(m), m]));
      const cfg = loadConfig();
      const choices = (preferred?: string) => {
        const all = [...byLabel.keys()];
        return preferred && byLabel.has(preferred) ? [preferred, ...all.filter((l) => l !== preferred)] : all;
      };
      const implLabel = await ctx.ui.select(
        "Implementer model",
        choices(cfg.implementer ?? (ctx.model && label(ctx.model))),
      );
      if (!implLabel) return;
      const revLabel = await ctx.ui.select("Reviewer model", choices(cfg.reviewer));
      if (!revLabel) return;
      fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
      fs.writeFileSync(CONFIG_PATH, JSON.stringify({ implementer: implLabel, reviewer: revLabel }, null, 2));

      const runId = new Date().toISOString().replace(/[:.]/g, "-");
      const runDir = path.join(root.out, ".pi", "ai-pair", runId);
      const scratchDir = path.join(runDir, "scratch");
      fs.mkdirSync(scratchDir, { recursive: true });
      fs.writeFileSync(path.join(root.out, ".pi", "ai-pair", ".gitignore"), "*\n");
      const planFile = path.join(runDir, "plan.md");
      const systemFile = path.join(runDir, "reviewer-system.md");
      const sessionFile = path.join(runDir, "reviewer.jsonl");
      fs.writeFileSync(systemFile, REVIEWER_SYSTEM);

      const stash = await git(pi, root.out, "stash", "create");
      const base = stash.ok && stash.out ? stash.out : (await git(pi, root.out, "rev-parse", "HEAD")).out;

      const origModel = ctx.model;
      const origThinking = pi.getThinkingLevel();
      const log: RoundLog[] = [];
      const abort = new AbortController();
      const offInput = ctx.ui.onTerminalInput((d) => {
        if (d === "\x1b" || d === "\x03") abort.abort();
        return undefined;
      });
      const status = (s?: string) => ctx.ui.setStatus("ai-pair", s);

      let outcome = "";
      let maxRounds = initialRounds;
      let lastImplText = "";
      let lastVerdict: Verdict | undefined;
      running = true;
      try {
        const implModel = byLabel.get(implLabel)!;
        if (!(await pi.setModel(implModel))) throw new Error(`No credentials for ${implLabel}`);

        status(`ai-pair: planning (${implLabel})`);
        const plan = await runImplementerTurn(
          ctx,
          `We're starting an implementer/reviewer pair run. Write a distilled plan for the work agreed so far${task ? ` (focus: ${task})` : ""} to ${planFile}. ` +
            `Include: goal, key decisions, constraints, acceptance checks. A separate reviewer will read only this file, not our conversation. Write the file and nothing else; do not start implementing.`,
        );
        if (plan.aborted || plan.error) throw new Error(plan.error ?? "aborted during planning");
        if (!fs.existsSync(planFile)) throw new Error("implementer did not write plan.md");
        if (confirmPlan && !(await ctx.ui.confirm("ai-pair", `Plan written to ${planFile}. Start implementing?`))) {
          outcome = "Stopped after plan (not confirmed).";
          return;
        }

        for (let round = 1; ; round++) {
          if (round > maxRounds) {
            const more =
              lastVerdict &&
              (await ctx.ui.select(`Reviewer still requests changes after ${maxRounds} rounds`, [
                "Stop and review myself",
                "Run one more round",
              ]));
            if (more !== "Run one more round") {
              outcome = `Escalated: not approved after ${maxRounds} rounds.`;
              break;
            }
            maxRounds++;
          }

          status(`ai-pair: round ${round}/${maxRounds} · implementer ${implLabel}`);
          const implPrompt =
            round === 1
              ? `Implement the plan in ${planFile}. When done, summarise what you changed and anything you're unsure about.`
              : `The reviewer (${revLabel}) requested changes. Outstanding findings:\n\n${formatFindings(lastVerdict!.findings)}\n\n` +
                `Fix the ones you agree with. If you disagree with a finding, don't change code for it; dispute it with a concrete rationale. ` +
                `End your reply with one line per finding id: FIXED <id> or DISPUTED <id>: <rationale>.`;
          const impl = await runImplementerTurn(ctx, implPrompt);
          if (impl.aborted) {
            outcome = `Interrupted during round ${round} (implementer).`;
            break;
          }
          if (impl.error) throw new Error(`implementer: ${impl.error}`);
          lastImplText = impl.text;

          status(`ai-pair: round ${round}/${maxRounds} · reviewer ${revLabel}`);
          const diffInfo = `Base: ${base}\nSee changes: \`git diff ${base}\` and \`git status --short\` (for untracked files).\n`;
          const revPrompt =
            round === 1
              ? `Review round 1.\nPlan: ${planFile}\n${diffInfo}Scratch dir: ${scratchDir}\n\nImplementer's summary:\n${impl.text}`
              : `Review round ${round}.\n${diffInfo}\nImplementer's response:\n${impl.text}\n\nRe-verify each prior finding and look for new regressions.`;
          let result = await runReviewer({
            cwd: ctx.cwd,
            model: revLabel,
            sessionFile,
            systemFile,
            prompt: revPrompt,
            signal: abort.signal,
            onActivity: (tool) => status(`ai-pair: round ${round}/${maxRounds} · reviewer ${revLabel} (${tool})`),
          });
          if (!result.verdict && !result.aborted) {
            result = await runReviewer({
              cwd: ctx.cwd,
              model: revLabel,
              sessionFile,
              systemFile,
              prompt: "You did not call submit_review. Call it now with your verdict.",
              signal: abort.signal,
              onActivity: () => {},
            });
          }
          if (result.aborted) {
            outcome = `Interrupted during round ${round} (reviewer).`;
            break;
          }
          if (!result.verdict) {
            throw new Error(`reviewer returned no verdict. ${result.stderr.trim().split("\n").slice(-5).join("\n")}`);
          }
          lastVerdict = result.verdict;
          log.push({ round, implementer: impl.text, verdict: result.verdict });
          ctx.ui.notify(
            `Round ${round}: ${result.verdict.verdict} (${result.verdict.findings.length} open, ${result.verdict.resolved.length} resolved)`,
            result.verdict.verdict === "approve" ? "info" : "warning",
          );
          if (result.verdict.verdict === "approve") {
            outcome = `Approved in round ${round}.`;
            break;
          }
        }
      } catch (e) {
        outcome = `Failed: ${e instanceof Error ? e.message : String(e)}`;
        ctx.ui.notify(outcome, "error");
      } finally {
        running = false;
        offInput();
        status(undefined);
        if (origModel) await pi.setModel(origModel);
        pi.setThinkingLevel(origThinking);
      }

      const diffstat = (await git(pi, root.out, "diff", "--stat", base)).out;
      const lines = [
        `## ai-pair report`,
        `**Outcome:** ${outcome}`,
        `**Implementer:** ${implLabel} · **Reviewer:** ${revLabel} · **Rounds:** ${log.length}`,
        ...log.map(
          (l) =>
            `\n### Round ${l.round}: ${l.verdict.verdict}\n${l.verdict.summary}` +
            (l.verdict.resolved.length ? `\nResolved: ${l.verdict.resolved.map((r) => r.id).join(", ")}` : "") +
            (l.verdict.findings.length ? `\nOpen:\n${formatFindings(l.verdict.findings)}` : ""),
        ),
        lastVerdict && lastVerdict.verdict !== "approve" && lastImplText
          ? `\n### Last implementer response\n${lastImplText}`
          : "",
        diffstat ? `\n\`\`\`\n${diffstat}\n\`\`\`` : "",
        `\nArtifacts: ${runDir}`,
      ];
      pi.sendMessage({ customType: "ai-pair", content: lines.filter(Boolean).join("\n"), display: true });
    },
  });
}
