import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PairConfig } from "./config.js";
import {
  countChanges,
  type Decision,
  initialState,
  mergeObservations,
  recordInterjection,
  recordObservation,
  shouldObserve,
} from "./policy.js";
import { renderObservation } from "./prompts.js";
import type { Observation, PolicyState, Role, Trigger } from "./types.js";
import { type EditWatcher, type OpenWatcher, openEditWatcher } from "./watcher.js";
import { WorkspaceSnapshot } from "./workspace.js";

export const OBSERVATION_MESSAGE = "pair/observation";

/** The answer whenever there is no runtime to ask. */
export const PAIR_OFF: Decision = { observe: false, reason: "pair mode is off" };

/** How often the idle nudge is considered; the policy decides whether it fires. */
const IDLE_TICK_MS = 60_000;

/**
 * Backstop for the in-flight flag. `agent_settled` clears it in practice; this
 * only matters if a turn dies without the event, where the cost of staying
 * stuck is that pairing silently stops for the rest of the session.
 */
const OBSERVATION_TIMEOUT_MS = 5 * 60_000;

const ignore = (): void => {};

export interface SessionDeps {
  pi: ExtensionAPI;
  /**
   * Shared with the controller by reference.
   *
   * `/pair set` mutates this object in place rather than replacing it, which is
   * how a live setting change reaches the watcher and the snapshot without a
   * restart. Copying it here would quietly break that.
   */
  config: PairConfig;
  now: () => number;
  /** The controller owns the role; the session only ever reads it. */
  role: () => Role;
  /** Something the pair widget renders has changed. */
  onChanged: (ctx: ExtensionContext) => void;
  /** The watcher died. The runtime cannot continue, and the driver must be told. */
  onWatcherFailed: (error: Error, ctx: ExtensionContext) => void;
  /** A look nobody was waiting on failed. Pairing continues. */
  onLookFailed: (error: Error, ctx: ExtensionContext) => void;
  /** Overridden in tests to substitute a watcher that fails on demand. */
  openWatcher?: OpenWatcher;
}

/** One look at the workspace, before the policy has had a say. */
interface LookRequest {
  trigger: Trigger;
  /** Absolute paths whose diffs this look should cover. */
  paths: string[];
  command?: Observation["command"];
  /** The driver's own words, when they asked directly. */
  question?: string;
}

/**
 * Everything that exists only while pairing is actually running: the watcher,
 * the baseline, the pacing tally, and the work waiting to be shown.
 *
 * The controller holds one of these when pairing is live and drops it when it
 * is not, which is what makes "stop" and "shut down" the same teardown with a
 * different answer to "was pairing on". Nothing here is meaningful once the
 * session is closed, so nothing here needs an is-it-still-on flag.
 */
export class PairSession {
  private readonly snapshot: WorkspaceSnapshot;
  private readonly state: PolicyState;
  private readonly openWatcher: OpenWatcher;
  private watcher: EditWatcher | undefined;
  private idleTimer: NodeJS.Timeout | undefined;
  /** Changes seen but not yet worth showing, and the reason they are waiting. */
  private held: { observation: Observation; reason?: string } | undefined;
  /**
   * When the current observation was handed to the model, or undefined when the
   * navigator is free. Cleared by `agent_settled` rather than at send time: the
   * send returns immediately and the turn runs after it, so clearing eagerly
   * would let a second burst interrupt a turn already in progress.
   */
  private observingSince: number | undefined;
  private truncated = false;
  private closed = false;
  /** Serializes watcher, command-failure, idle, and manual looks. */
  private queue: Promise<void> = Promise.resolve();

  /**
   * Brings up the runtime: watcher, baseline, and idle loop.
   *
   * `ctx` is kept for the work the session starts on its own — a watcher
   * callback and a timer have no caller to borrow one from. Anything the driver
   * initiates passes its own, which is the one that knows whether the agent is
   * mid-turn.
   */
  static async start(deps: SessionDeps, ctx: ExtensionContext, muted = false): Promise<PairSession> {
    const session = new PairSession(deps, ctx, muted);
    try {
      await session.open();
    } catch (error) {
      // The watcher may already be up, and nothing outside will ever hold a
      // reference to this session, so it has to clean up after itself.
      await session.close();
      throw error;
    }
    return session;
  }

  private constructor(
    private readonly deps: SessionDeps,
    private readonly ctx: ExtensionContext,
    muted: boolean,
  ) {
    this.snapshot = new WorkspaceSnapshot(ctx.cwd, deps.config);
    this.state = initialState(deps.now());
    this.state.muted = muted;
    this.openWatcher = deps.openWatcher ?? openEditWatcher;
  }

  /** True when the repo was too large to baseline fully. */
  get seedTruncated(): boolean {
    return this.truncated;
  }

  get muted(): boolean {
    return this.state.muted;
  }

  /** What the widget shows: work waiting, and why it is still waiting. */
  get pending(): Readonly<{ observation: Observation; reason?: string }> | undefined {
    return this.held;
  }

  setMuted(muted: boolean): void {
    this.state.muted = muted;
  }

  /** The gap clock starts when the navigator speaks, not when it looks. */
  noteInterjection(): void {
    recordInterjection(this.state, this.deps.now());
  }

  /** The navigator looked and chose silence, so why it waited is no longer news. */
  noteQuiet(): void {
    if (this.held) this.held.reason = undefined;
  }

  /** Frees the in-flight flag. True when that actually changed something. */
  noteAgentSettled(): boolean {
    if (this.observingSince === undefined) return false;
    this.observingSince = undefined;
    return true;
  }

  /**
   * Discards work held for the navigator.
   *
   * Used when the agent takes the keyboard: those patches describe a tree it is
   * about to rewrite, so they would be stale by the time anyone saw them.
   */
  dropPending(): void {
    this.held = undefined;
  }

  /** Handles a settled burst of driver edits. The watcher's entry point. */
  observeEdits(paths: string[], ctx: ExtensionContext): Promise<Decision> {
    return this.enqueue({ trigger: "edit-burst", paths }, ctx);
  }

  /** Records that the driver's shell command failed, which always earns a look. */
  reportFailedCommand(command: Observation["command"], ctx: ExtensionContext): void {
    this.inBackground(this.enqueue({ trigger: "failed-command", paths: [], command }, ctx), ctx);
  }

  /** Forces a look right now, regardless of pacing. Used by `/pair look`. */
  lookNow(ctx: ExtensionContext, question?: string): Promise<Decision> {
    return this.enqueue({ trigger: "manual", paths: this.watcher?.takePending() ?? [], question }, ctx);
  }

  /** Rebuilds the watcher after an ignore-rule change, keeping the baseline. */
  async restartWatcher(): Promise<void> {
    await this.watcher?.stop();
    const ready = await this.createWatcher().start();
    await this.snapshot.seedMissing(ready.files);
    this.truncated = ready.truncated;
  }

  /** Releases everything the runtime owns. Looks still queued become no-ops. */
  async close(): Promise<void> {
    this.closed = true;
    if (this.idleTimer) clearInterval(this.idleTimer);
    this.idleTimer = undefined;
    this.held = undefined;
    this.observingSince = undefined;
    const watcher = this.watcher;
    this.watcher = undefined;
    await watcher?.stop();
  }

  private async open(): Promise<void> {
    const ready = await this.createWatcher().start();
    await this.snapshot.seed(ready.files);
    this.truncated = ready.truncated;
    this.idleTimer = setInterval(() => {
      this.inBackground(this.enqueue({ trigger: "idle-nudge", paths: [] }, this.ctx), this.ctx);
    }, IDLE_TICK_MS);
    this.idleTimer.unref?.();
  }

  private createWatcher(): EditWatcher {
    const watcher = this.openWatcher({
      root: this.ctx.cwd,
      config: this.deps.config,
      onBurst: (paths) => this.inBackground(this.enqueue({ trigger: "edit-burst", paths }, this.ctx), this.ctx),
      onEdit: () => {
        this.state.lastEditAt = this.deps.now();
      },
      onError: (error) => {
        // The watcher has already torn itself down; keep our own state honest.
        if (this.watcher === watcher) this.watcher = undefined;
        this.deps.onWatcherFailed(error, this.ctx);
      },
    });
    this.watcher = watcher;
    return watcher;
  }

  private enqueue(request: LookRequest, ctx: ExtensionContext): Promise<Decision> {
    const run = this.queue.then(() => this.look(request, ctx));
    // The queue only sequences. A look that throws must not poison the ones
    // behind it, and its caller — if it has one — gets the rejection instead.
    this.queue = run.then(ignore, ignore);
    return run;
  }

  /**
   * Absorbs the failure of a look nobody is waiting on.
   *
   * A watcher callback and a timer have no caller to reject into, and an
   * unhandled rejection from either would take the process down with it.
   */
  private inBackground(look: Promise<Decision>, ctx: ExtensionContext): void {
    void look.catch((error: unknown) => {
      this.deps.onLookFailed(error instanceof Error ? error : new Error(String(error)), ctx);
    });
  }

  private async look(request: LookRequest, ctx: ExtensionContext): Promise<Decision> {
    if (this.closed) return PAIR_OFF;
    const { trigger, paths } = request;

    // In driver mode the agent is doing the editing; watching its own diffs
    // would be a feedback loop, not a pairing session. Its writes still go into
    // the baseline, so handing the keyboard back does not dump everything the
    // agent just wrote onto the navigator as if the driver had typed it.
    if (this.deps.role() === "driver" && trigger !== "manual") {
      if (paths.length > 0) await this.snapshot.commit(paths);
      return { observe: false, reason: "agent has the keyboard" };
    }

    const now = this.deps.now();
    const files = paths.length > 0 ? await this.snapshot.diff(paths) : [];
    const merged = this.foldInHeld(
      { trigger, at: now, files, ...countChanges(files), command: request.command },
      paths,
    );

    // Nothing changed and nothing to react to: not worth a round-trip.
    if (merged.files.length === 0 && !merged.command && trigger === "edit-burst") {
      this.held = undefined;
      return { observe: false, reason: "nothing changed" };
    }

    const decision = this.busyReason(trigger, ctx) ?? shouldObserve(merged, this.state, this.deps.config, now);
    if (!decision.observe) {
      // Real edits and failures wait for the next look. Empty idle checks are
      // simply retried by the timer; presenting them as +0/-0 pending work
      // makes the widget look broken.
      const worthKeeping = merged.files.length > 0 || merged.command !== undefined;
      this.held = worthKeeping ? { observation: merged, reason: decision.reason } : undefined;
      this.deps.onChanged(ctx);
      return decision;
    }

    this.held = undefined;
    if (trigger === "idle-nudge") this.state.lastIdleNudgeAt = now;
    recordObservation(this.state, now);
    // Advance the baseline for everything actually shown, not just the paths in
    // the burst that tripped the threshold: files folded in from earlier held
    // bursts have been shown too, and re-showing them makes the navigator
    // repeat itself.
    const shown = merged.files.map((file) => this.snapshot.toAbsolute(file.path));
    if (shown.length > 0) await this.snapshot.commit(shown);
    this.send(merged, request.question, ctx);
    this.deps.onChanged(ctx);
    return decision;
  }

  /**
   * Folds anything held from an earlier look into this one.
   *
   * A fresh diff supersedes what was held for the same file, including a file
   * the driver has since put back: a reverted file does not come back in the
   * new diff, so dropping the held copy is what removes it from the report.
   */
  private foldInHeld(fresh: Observation, paths: string[]): Observation {
    const held = this.held?.observation;
    if (!held) return fresh;
    if (paths.length === 0) return mergeObservations(held, fresh);

    const superseded = new Set(
      paths.map((path) => this.snapshot.toRelative(path)).filter((path) => path !== undefined),
    );
    const kept = held.files.filter((file) => !superseded.has(file.path));
    return mergeObservations({ ...held, files: kept, ...countChanges(kept) }, fresh);
  }

  /** Hands the observation to the model. */
  private send(observation: Observation, question: string | undefined, ctx: ExtensionContext): void {
    const body = renderObservation(observation, this.deps.config.maxFilesPerObservation);
    const content = question ? `${body}\n\nThe driver also asked: ${question}` : body;
    this.observingSince = this.deps.now();

    // A manual look is the driver's own question, so it belongs in their
    // transcript. An unprompted one does not: nobody asked for it.
    if (observation.trigger === "manual") {
      this.deps.pi.sendUserMessage(content, ctx.isIdle() ? undefined : { deliverAs: "followUp" });
      return;
    }
    this.deps.pi.sendMessage(
      {
        customType: OBSERVATION_MESSAGE,
        content,
        display: false,
        details: { trigger: observation.trigger, files: observation.files.map((file) => file.path) },
      },
      { triggerTurn: true, deliverAs: "followUp" },
    );
  }

  /**
   * Refuses an unprompted look while a turn is already running.
   *
   * The whole point of the pacing is not to interrupt, and queuing a second
   * observation behind one the navigator has not answered yet interrupts the
   * navigator instead of the driver. A direct question is exempt — the driver
   * asked, so they can decide whether the timing is good.
   */
  private busyReason(trigger: Trigger, ctx: ExtensionContext): Decision | undefined {
    if (trigger === "manual") return undefined;
    if (this.isObserving()) return { observe: false, reason: "still thinking about the last look" };
    if (!ctx.isIdle()) return { observe: false, reason: "agent is mid-turn" };
    return undefined;
  }

  private isObserving(): boolean {
    if (this.observingSince === undefined) return false;
    if (this.deps.now() - this.observingSince <= OBSERVATION_TIMEOUT_MS) return true;
    this.observingSince = undefined;
    return false;
  }
}
