import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type Runtime, projectImage } from "./install.ts";

const BRIDGE = path.join(path.dirname(fileURLToPath(import.meta.url)), "bridge.st");
const READY = "PI-BRIDGE-READY";
const START_TIMEOUT_MS = 60_000;
const QUIT_TIMEOUT_MS = 30_000;
/** How long past its own timeout the bridge gets to answer before the VM counts as wedged. */
const GRACE_MS = 15_000;

export interface BridgeError {
  class: string;
  description: string;
  stack: string[];
}

export type Reply<T> =
  | { ok: true; value: T; transcript: string }
  | { ok: false; error: BridgeError; transcript: string };

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

/** Pharo writes CR line ends. */
export function lines(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

/** One running VM serving one project image through bridge.st. */
class Session {
  private output = "";
  readonly exited: Promise<void>;
  private alive = true;

  constructor(
    private readonly child: ChildProcess,
    private readonly port: number,
    private readonly token: string,
  ) {
    const collect = (chunk: Buffer) => {
      this.output = (this.output + chunk.toString()).slice(-8000);
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    this.exited = new Promise((resolve) => child.once("exit", () => resolve()));
    this.exited.then(() => (this.alive = false));
  }

  static async start(runtime: Runtime, image: string, cwd: string): Promise<Session> {
    const port = await freePort();
    const token = randomBytes(24).toString("hex");
    const child = spawn(runtime.vm, ["--headless", image, "st", "--no-source", BRIDGE], {
      cwd,
      env: { ...process.env, PI_SMALLTALK_PORT: String(port), PI_SMALLTALK_TOKEN: token },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const session = new Session(child, port, token);
    await session.ready();
    return session;
  }

  private ready(): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => fail(new Error("timed out")), START_TIMEOUT_MS);
      const fail = (cause: Error) => {
        clearTimeout(timer);
        this.kill();
        reject(new Error(`Pharo did not start (${cause.message}):\n${this.output}`));
      };
      this.child.once("error", fail);
      this.exited.then(() => fail(new Error("the VM exited")));
      this.child.stdout?.on("data", () => {
        if (!this.output.includes(READY)) return;
        clearTimeout(timer);
        resolve();
      });
    });
  }

  get running(): boolean {
    return this.alive;
  }

  get recentOutput(): string {
    return this.output;
  }

  async request<T>(body: Record<string, unknown>, deadlineMs: number): Promise<Reply<T>> {
    const res = await fetch(`http://127.0.0.1:${this.port}/`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Pi-Token": this.token },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(deadlineMs),
    });
    if (!res.ok) throw new Error(`Bridge answered ${res.status}`);
    const reply = (await res.json()) as Record<string, unknown>;
    return { transcript: "", ...reply } as Reply<T>;
  }

  /** Asks the image to quit, saving first if asked to, and kills it if it does not. */
  async quit(save: boolean): Promise<void> {
    if (!this.alive) return;
    try {
      await this.request({ op: "quit", save }, QUIT_TIMEOUT_MS);
    } catch {
      return this.kill();
    }
    const timer = setTimeout(() => this.kill(), QUIT_TIMEOUT_MS);
    await this.exited;
    clearTimeout(timer);
  }

  kill(): void {
    if (!this.alive) return;
    // Dead from now on, not from the exit event, so the next call starts a fresh VM.
    this.alive = false;
    this.child.kill("SIGKILL");
  }
}

export interface CallOptions {
  timeoutMs: number;
  signal?: AbortSignal;
}

/**
 * The project's persistent image. It starts on first use and comes back up
 * after crashing or being killed, from whatever it last saved.
 */
export class Image {
  private session?: Session;
  private starting?: Promise<Session>;
  private dirty = false;

  /** `dir` holds the image; `cwd` is the working directory the VM runs in. */
  constructor(
    private readonly runtime: Runtime,
    private readonly dir: string,
    private readonly cwd: string,
  ) {}

  get running(): boolean {
    return !!this.session?.running;
  }

  private connect(): Promise<Session> {
    if (this.session?.running) return Promise.resolve(this.session);
    this.starting ??= Session.start(this.runtime, projectImage(this.runtime, this.dir), this.cwd).then(
      (session) => {
        this.session = session;
        this.starting = undefined;
        return session;
      },
      (e) => {
        this.starting = undefined;
        throw e;
      },
    );
    return this.starting;
  }

  /**
   * Sends an op. The bridge enforces `timeoutMs` itself; aborting `signal` asks it
   * to interrupt. A VM that stops answering altogether is killed.
   */
  async call<T>(op: string, args: Record<string, unknown>, { timeoutMs, signal }: CallOptions): Promise<Reply<T>> {
    const session = await this.connect();
    this.dirty = true;
    const interrupt = () => void session.request({ op: "interrupt" }, 5_000).catch(() => {});
    signal?.addEventListener("abort", interrupt, { once: true });
    try {
      return await session.request<T>({ op, ...args, timeoutMs }, timeoutMs + GRACE_MS);
    } catch (e) {
      const reason = session.running ? `stopped answering (${(e as Error).message})` : "exited";
      session.kill();
      throw new Error(
        `The Smalltalk VM ${reason}. It restarts from the last saved image on the next call; ` +
          `changes since that save are lost.\n${lines(session.recentOutput).slice(-2000)}`,
      );
    } finally {
      signal?.removeEventListener("abort", interrupt);
    }
  }

  async save(): Promise<void> {
    const session = await this.connect();
    const reply = await session.request<unknown>({ op: "save" }, 120_000);
    if (!reply.ok) throw new Error(`Saving the image failed: ${reply.error.description}`);
    this.dirty = false;
  }

  async saveIfDirty(): Promise<void> {
    if (this.dirty && this.running) await this.save();
  }

  /** Quits the VM; `save: false` throws away everything since the last save. */
  async stop(save: boolean): Promise<void> {
    await this.starting?.catch(() => {});
    const session = this.session;
    this.session = undefined;
    this.dirty = false;
    await session?.quit(save);
  }
}
