import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";

export type ReviewOutcome = { kind: "done"; text: string } | { kind: "failed"; error: string };

type State = "running" | "idle" | "dead";

const TOOLS = "read,grep,find,ls,bash";

function piInvocation(args: string[]): { command: string; args: string[] } {
  const script = process.argv[1];
  if (script && !script.startsWith("/$bunfs/root/") && fs.existsSync(script)) {
    return { command: process.execPath, args: [script, ...args] };
  }
  return { command: "pi", args };
}

function tail(text: string): string {
  return text.trim().split("\n").slice(-5).join("\n");
}

/**
 * A long-lived reviewer: a headless pi in RPC mode that keeps its context between rounds.
 * Every settled run reports one outcome through `onOutcome`.
 */
export class Reviewer {
  readonly id: string;
  readonly model: string;
  private state: State = "idle";
  private readonly proc: ChildProcess;
  private readonly onOutcome: (reviewer: Reviewer, outcome: ReviewOutcome) => void;
  private stdout = "";
  private stderr = "";
  private lastText = "";
  private lastError = "";

  constructor(opts: {
    id: string;
    model: string;
    cwd: string;
    promptFile: string;
    onOutcome: (reviewer: Reviewer, outcome: ReviewOutcome) => void;
  }) {
    this.id = opts.id;
    this.model = opts.model;
    this.onOutcome = opts.onOutcome;
    const inv = piInvocation([
      "--mode",
      "rpc",
      "--no-session",
      "--model",
      opts.model,
      "--tools",
      TOOLS,
      "--append-system-prompt",
      opts.promptFile,
    ]);
    this.proc = spawn(inv.command, inv.args, { cwd: opts.cwd, stdio: ["pipe", "pipe", "pipe"] });
    this.proc.stdout!.on("data", (d) => this.read(d.toString()));
    this.proc.stderr!.on("data", (d) => (this.stderr += d.toString()));
    this.proc.on("error", (e) => this.die(String(e)));
    this.proc.on("exit", (code, signal) => this.die(`reviewer exited (${signal ?? code}). ${tail(this.stderr)}`));
  }

  get running(): boolean {
    return this.state === "running";
  }

  get alive(): boolean {
    return this.state !== "dead";
  }

  /**
   * Steers a running review, or starts a new round in the same context when idle.
   */
  send(message: string): void {
    if (this.state === "dead") throw new Error(`Review ${this.id} has ended; request a new review.`);
    this.state = "running";
    this.proc.stdin!.write(`${JSON.stringify({ type: "prompt", message, streamingBehavior: "steer" })}\n`);
  }

  stop(): void {
    if (this.state === "dead") return;
    this.state = "dead";
    this.proc.stdin!.end();
    setTimeout(() => this.proc.kill("SIGKILL"), 2000).unref();
  }

  private read(chunk: string): void {
    this.stdout += chunk;
    const lines = this.stdout.split("\n");
    this.stdout = lines.pop() ?? "";
    for (const line of lines) {
      let event: any;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      this.handle(event);
    }
  }

  private handle(event: any): void {
    if (event.type === "response" && !event.success) {
      this.settle({ kind: "failed", error: `${event.command} rejected: ${event.error}` });
    } else if (event.type === "message_end" && event.message?.role === "assistant") {
      const text = (event.message.content as any[])
        .filter((p) => p.type === "text")
        .map((p) => p.text)
        .join("\n")
        .trim();
      if (text) this.lastText = text;
      if (event.message.errorMessage) this.lastError = event.message.errorMessage;
    } else if (event.type === "agent_settled") {
      this.settle(
        this.lastText
          ? { kind: "done", text: this.lastText }
          : { kind: "failed", error: this.lastError || "no output" },
      );
    }
  }

  private settle(outcome: ReviewOutcome): void {
    if (this.state !== "running") return;
    this.state = "idle";
    this.lastText = "";
    this.lastError = "";
    this.onOutcome(this, outcome);
  }

  private die(error: string): void {
    if (this.state === "dead") return;
    const wasRunning = this.state === "running";
    this.state = "dead";
    if (wasRunning) this.onOutcome(this, { kind: "failed", error });
  }
}
