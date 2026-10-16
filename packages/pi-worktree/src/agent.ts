import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import { StringDecoder } from "node:string_decoder";

/** One stdout record from `pi --mode rpc`: a response, a session event, or an extension UI request. */
export type RpcRecord = { type: string; [key: string]: unknown };

/** An extension dialog in the child, answered by the parent's UI. */
export interface UiRequest {
  method: "select" | "confirm" | "input" | "editor";
  title: string;
  message?: string;
  options?: string[];
  placeholder?: string;
  prefill?: string;
}

export type UiAnswer = { value: string } | { confirmed: boolean } | { cancelled: true };

export type AgentState = { kind: "starting" | "idle" | "running" } | { kind: "dead"; reason: string };

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
 * A headless pi in RPC mode running in a worktree.
 * `args` picks the session, e.g. `["--fork", file]` or `["--continue"]`.
 */
export class Agent {
  state: AgentState = { kind: "starting" };
  /** Footer status entries the child's extensions set, by key. */
  readonly statuses = new Map<string, string>();
  private readonly proc: ChildProcess;
  private readonly listeners = new Set<(record: RpcRecord) => void>();
  private readonly pending = new Map<string, { resolve: (data: unknown) => void; reject: (error: Error) => void }>();
  private nextId = 0;
  private stdout = "";
  private stderr = "";
  private readonly exited: Promise<void>;

  constructor(
    readonly cwd: string,
    args: string[],
    private readonly onUi: (request: UiRequest) => Promise<UiAnswer>,
  ) {
    const inv = piInvocation(["--mode", "rpc", ...args]);
    this.proc = spawn(inv.command, inv.args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
    // RPC records may contain U+2028/U+2029, so split on LF only, never with readline.
    const decoder = new StringDecoder("utf8");
    this.proc.stdout!.on("data", (chunk: Buffer) => this.read(decoder.write(chunk)));
    this.proc.stderr!.on("data", (chunk: Buffer) => (this.stderr = (this.stderr + chunk.toString()).slice(-8192)));
    // A failed spawn emits "error" without "exit"; either one ends the agent.
    this.exited = new Promise((resolve) => {
      this.proc.on("error", (error) => {
        this.die(String(error));
        resolve();
      });
      this.proc.on("exit", (code, signal) => {
        this.die(`exited (${signal ?? code}). ${tail(this.stderr)}`);
        resolve();
      });
    });
  }

  get running(): boolean {
    return this.state.kind === "running";
  }

  get dead(): boolean {
    return this.state.kind === "dead";
  }

  onRecord(listener: (record: RpcRecord) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * `onData` runs synchronously, in stream order, before any record after the response;
   * use it when the data must line up with the event stream.
   */
  request<T = unknown>(command: Record<string, unknown>, onData?: (data: T) => void): Promise<T> {
    if (this.state.kind === "dead") return Promise.reject(new Error(`Agent ${this.state.reason}`));
    const id = `wt-${++this.nextId}`;
    return new Promise<T>((resolve, reject) => {
      const settle = (data: unknown) => {
        onData?.(data as T);
        resolve(data as T);
      };
      this.pending.set(id, { resolve: settle, reject });
      this.write({ ...command, id });
    });
  }

  /** Starts a run when idle; steers the current run otherwise. */
  async send(message: string): Promise<void> {
    await this.request({ type: "prompt", message, streamingBehavior: "steer" });
  }

  async abort(): Promise<void> {
    await this.request({ type: "abort" });
  }

  /** Closes stdin for an orderly shutdown, kills a child that does not exit, and resolves on exit. */
  stop(): Promise<void> {
    if (!this.dead) {
      this.proc.stdin!.end();
      const kill = setTimeout(() => this.proc.kill("SIGTERM"), 3000);
      kill.unref();
      void this.exited.then(() => clearTimeout(kill));
    }
    return this.exited;
  }

  private write(record: Record<string, unknown>): void {
    this.proc.stdin!.write(`${JSON.stringify(record)}\n`);
  }

  private read(chunk: string): void {
    this.stdout += chunk;
    let newline: number;
    while ((newline = this.stdout.indexOf("\n")) >= 0) {
      const line = this.stdout.slice(0, newline).replace(/\r$/, "");
      this.stdout = this.stdout.slice(newline + 1);
      if (!line.trim()) continue;
      let record: RpcRecord;
      try {
        record = JSON.parse(line) as RpcRecord;
      } catch {
        continue;
      }
      this.handle(record);
    }
  }

  private handle(record: RpcRecord): void {
    if (record.type === "response" && typeof record.id === "string" && this.pending.has(record.id)) {
      // The first answer means the child finished startup.
      if (this.state.kind === "starting") this.state = { kind: "idle" };
      const pending = this.pending.get(record.id)!;
      this.pending.delete(record.id);
      if (record.success) pending.resolve(record.data);
      else pending.reject(new Error(String(record.error ?? "RPC command failed")));
      return;
    }
    if (record.type === "extension_ui_request") {
      this.handleUi(record);
      return;
    }
    if (this.state.kind !== "dead") {
      if (record.type === "agent_start") this.state = { kind: "running" };
      else if (record.type === "agent_settled") this.state = { kind: "idle" };
    }
    this.emit(record);
  }

  /** One failing listener must not stop the others, or the stdout reader that called it. */
  private emit(record: RpcRecord): void {
    for (const listener of this.listeners) {
      try {
        listener(record);
      } catch {
        // Writing to stderr would corrupt the TUI; the listener owns its own error reporting.
      }
    }
  }

  private handleUi(record: RpcRecord): void {
    const method = record.method as string;
    if (method === "setStatus" || method === "notify") {
      if (method === "setStatus") {
        const key = String(record.statusKey);
        if (typeof record.statusText === "string") this.statuses.set(key, record.statusText);
        else this.statuses.delete(key);
      }
      this.emit(record);
      return;
    }
    if (method !== "select" && method !== "confirm" && method !== "input" && method !== "editor") return;
    const id = record.id;
    this.onUi({
      method,
      title: String(record.title ?? ""),
      message: record.message as string | undefined,
      options: record.options as string[] | undefined,
      placeholder: record.placeholder as string | undefined,
      prefill: record.prefill as string | undefined,
    }).then(
      (answer) => !this.dead && this.write({ type: "extension_ui_response", id, ...answer }),
      () => !this.dead && this.write({ type: "extension_ui_response", id, cancelled: true }),
    );
  }

  private die(reason: string): void {
    if (this.state.kind === "dead") return;
    this.state = { kind: "dead", reason };
    for (const { reject } of this.pending.values()) reject(new Error(`Agent ${reason}`));
    this.pending.clear();
    this.emit({ type: "agent_exit", reason });
  }
}
