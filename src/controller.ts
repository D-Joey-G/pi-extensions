import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { makeConfig, type PairConfig } from "./config.js";
import {
  type Decision,
  initialState,
  mergeObservations,
  recordInterjection,
  recordObservation,
  shouldObserve,
} from "./policy.js";
import { DRIVER_HANDOFF_PROMPT, NAVIGATOR_PROMPT, notesContext, renderObservation } from "./prompts.js";
import { applyRole, withoutPairTools } from "./roles.js";
import type { Cadence, Observation, PairNote, PolicyState, Role, Trigger } from "./types.js";
import { EditWatcher } from "./watcher.js";
import { WorkspaceSnapshot } from "./workspace.js";

export const NOTE_ENTRY = "pair/note";
export const STATE_ENTRY = "pair/state";
export const OBSERVATION_MESSAGE = "pair/observation";

/**
 * Backstop for the in-flight flag. `agent_settled` clears it in practice; this
 * only matters if a turn dies without the event, where the cost of staying
 * stuck is that pairing silently stops for the rest of the session.
 */
const OBSERVATION_TIMEOUT_MS = 5 * 60_000;

interface PersistedState {
  active: boolean;
  cadence: Cadence;
  role: Role;
  muted: boolean;
  overrides: Partial<PairConfig>;
  baselineTools: string[];
}

export interface ControllerHooks {
  /** Surfaces a watcher failure, which otherwise ends pairing silently. */
  onWatcherError?: (error: Error, ctx: ExtensionContext) => void;
}

/**
 * Owns the pairing session: what the driver changed, whether it is worth a
 * remark, and which role each side is currently playing.
 */
export class PairController {
  private overrides: Partial<PairConfig> = {};
  private config: PairConfig = makeConfig();
  private state: PolicyState = initialState(Date.now());
  private role: Role = "navigator";
  private active = false;
  private watcher: EditWatcher | undefined;
  private snapshot: WorkspaceSnapshot | undefined;
  /** Undefined until a session captures it; distinct from "captured as empty". */
  private baselineTools: string[] | undefined;
  private notes: PairNote[] = [];
  private pending: Observation | undefined;
  /**
   * When the current observation was handed to the model, or undefined when the
   * navigator is free. Cleared by `agent_settled` rather than at send time: the
   * send returns immediately and the turn runs after it, so clearing eagerly
   * would let a second burst interrupt a turn already in progress.
   */
  private observingSince: number | undefined;
  private lastDecision = "";
  /** True when the repo was too large to baseline fully at startup. */
  private seedTruncated = false;
  /** Serializes watcher, command-failure, idle, and manual observations. */
  private burstQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly pi: ExtensionAPI,
    private readonly hooks: ControllerHooks = {},
  ) {}

  get isActive(): boolean {
    return this.active;
  }

  get currentRole(): Role {
    return this.role;
  }

  get currentCadence(): Cadence {
    return this.config.cadence;
  }

  get currentConfig(): PairConfig {
    return this.config;
  }

  get isMuted(): boolean {
    return this.state.muted;
  }

  get sessionNotes(): readonly PairNote[] {
    return this.notes;
  }

  private get observing(): boolean {
    if (this.observingSince === undefined) return false;
    if (Date.now() - this.observingSince > OBSERVATION_TIMEOUT_MS) {
      this.observingSince = undefined;
      return false;
    }
    return true;
  }

  /** The system prompt fragment for the current role, or undefined when off. */
  systemPromptSuffix(): string | undefined {
    if (!this.active) return undefined;
    const base = this.role === "navigator" ? NAVIGATOR_PROMPT : DRIVER_HANDOFF_PROMPT;
    return `${base}${notesContext(this.notes)}`;
  }

  async start(ctx: ExtensionContext, cadence: Cadence, overrides: Partial<PairConfig> = {}): Promise<void> {
    this.overrides = { ...overrides };
    this.config = makeConfig(cadence, this.overrides);
    this.state = initialState(Date.now());
    this.role = "navigator";
    this.active = true;
    this.baselineTools = withoutPairTools(this.pi.getActiveTools());

    try {
      await this.startWatching(ctx);
      applyRole(this.pi, this.role, this.baselineTools, this.config.extraReadOnlyTools);
      this.persist();
      this.updateUi(ctx);
    } catch (error) {
      this.active = false;
      await this.dispose(ctx);
      this.persist();
      throw error;
    }
  }

  /** Brings up the watcher and takes the baseline. Shared by `start` and `restore`. */
  private async startWatching(ctx: ExtensionContext): Promise<void> {
    this.snapshot = new WorkspaceSnapshot(ctx.cwd, this.config);
    const ready = await this.createWatcher(ctx).start();
    await this.snapshot.seed(ready.files);
    this.seedTruncated = ready.truncated;
  }

  private createWatcher(ctx: ExtensionContext): EditWatcher {
    const watcher = new EditWatcher(
      ctx.cwd,
      this.config,
      async (burst) => {
        await this.observeEdits(burst.paths, ctx);
      },
      (at) => {
        this.state.lastEditAt = at;
      },
      (error) => {
        // The watcher has already torn itself down; keep our own state honest.
        if (this.watcher === watcher) this.watcher = undefined;
        void this.stop(ctx);
        this.hooks.onWatcherError?.(error, ctx);
      },
    );
    this.watcher = watcher;
    return watcher;
  }

  /** Releases session resources without changing the persisted on/off choice. */
  async dispose(ctx: ExtensionContext | undefined): Promise<void> {
    await this.watcher?.stop();
    this.watcher = undefined;
    this.snapshot = undefined;
    this.pending = undefined;
    this.observingSince = undefined;
    if (this.baselineTools !== undefined) this.pi.setActiveTools(this.baselineTools);
    if (ctx?.hasUI) {
      ctx.ui.setWidget("pair", undefined);
      ctx.ui.setStatus("pair", undefined);
    }
  }

  async stop(ctx: ExtensionContext | undefined): Promise<void> {
    this.active = false;
    await this.dispose(ctx);
    this.persist();
  }

  setCadence(cadence: Cadence, ctx: ExtensionContext): void {
    // Overrides are kept separately from the resolved config, so a cadence
    // change reapplies the preset without discarding what the driver set.
    Object.assign(this.config, makeConfig(cadence, this.overrides));
    this.persist();
    this.updateUi(ctx);
  }

  /** Applies `/pair set` values on top of the current cadence preset. */
  async setOverrides(overrides: Partial<PairConfig>, ctx: ExtensionContext): Promise<void> {
    const ignoreChanged = overrides.ignore !== undefined;
    this.overrides = { ...this.overrides, ...overrides };
    Object.assign(this.config, makeConfig(this.config.cadence, this.overrides));
    if (this.active && this.baselineTools !== undefined) {
      // extraReadOnlyTools feeds the active tool set, so re-derive it.
      applyRole(this.pi, this.role, this.baselineTools, this.config.extraReadOnlyTools);
      if (ignoreChanged) await this.restartWatcher(ctx);
    }
    this.persist();
    this.updateUi(ctx);
  }

  private async restartWatcher(ctx: ExtensionContext): Promise<void> {
    await this.watcher?.stop();
    const ready = await this.createWatcher(ctx).start();
    await this.snapshot?.seedMissing(ready.files);
    this.seedTruncated = ready.truncated;
  }

  setMuted(muted: boolean, ctx: ExtensionContext): void {
    this.state.muted = muted;
    this.persist();
    this.updateUi(ctx);
  }

  setRole(role: Role, ctx: ExtensionContext): void {
    // Anything held from before the handoff describes a tree the agent is about
    // to rewrite, so the patches would be stale by the time they were shown.
    if (role === "driver") this.pending = undefined;
    this.role = role;
    applyRole(this.pi, role, this.baselineTools ?? [], this.config.extraReadOnlyTools);
    this.persist();
    this.updateUi(ctx);
  }

  addNote(note: PairNote, ctx: ExtensionContext): void {
    this.notes.push(note);
    this.pi.appendEntry(NOTE_ENTRY, note);
    this.updateUi(ctx);
  }

  noteInterjection(ctx: ExtensionContext): void {
    recordInterjection(this.state, Date.now());
    this.updateUi(ctx);
  }

  /** Records a look that ended in silence, so the widget can show the last verdict. */
  noteQuiet(reason: string | undefined, ctx: ExtensionContext): void {
    this.lastDecision = reason ? `last look: ${reason}` : "";
    this.updateUi(ctx);
  }

  /** Frees the in-flight flag once the navigator's turn has fully finished. */
  noteAgentSettled(ctx: ExtensionContext): void {
    if (this.observingSince === undefined) return;
    this.observingSince = undefined;
    this.updateUi(ctx);
  }

  /**
   * Handles a settled burst of driver edits. This is the watcher's entry point,
   * kept public so a caller can hand over paths directly without waiting on the
   * filesystem.
   */
  async observeEdits(paths: string[], ctx: ExtensionContext): Promise<Decision> {
    return this.enqueueBurst(paths, "edit-burst", ctx);
  }

  /** Records that the driver's shell command failed, which always earns a look. */
  async reportFailedCommand(command: string, exitCode: number, output: string, ctx: ExtensionContext): Promise<void> {
    if (!this.active || this.role !== "navigator") return;
    await this.enqueueBurst([], "failed-command", ctx, { command, exitCode, output });
  }

  /** Forces a look right now, regardless of pacing. Used by `/pair look`. */
  async lookNow(ctx: ExtensionContext, question?: string): Promise<Decision> {
    if (!this.active) return { observe: false, reason: "pair mode is off" };
    const paths = this.watcher?.takePending() ?? [];
    return this.enqueueBurst(paths, "manual", ctx, undefined, question);
  }

  /** Checks whether the driver has gone quiet long enough to offer help. */
  async maybeNudge(ctx: ExtensionContext): Promise<void> {
    if (!this.active || this.role !== "navigator") return;
    await this.enqueueBurst([], "idle-nudge", ctx);
  }

  /**
   * Rebuilds the session from the transcript.
   *
   * Notes always come back. The rest only matters when pairing was on when the
   * session ended, in which case the watcher and tool set are brought back up
   * too — restoring the label without the machinery would leave the widget
   * claiming to watch a tree nothing is watching.
   */
  async restore(ctx: ExtensionContext): Promise<void> {
    let persisted: PersistedState | undefined;
    // Rebuilt from the transcript each time, so a second session_start cannot
    // double up the notes.
    this.notes = [];
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom") continue;
      if (entry.customType === NOTE_ENTRY && entry.data) this.notes.push(entry.data as PairNote);
      if (entry.customType === STATE_ENTRY && entry.data) persisted = entry.data as PersistedState;
    }
    if (!persisted) return;

    this.role = persisted.role;
    this.overrides = persisted.overrides ?? {};
    this.config = makeConfig(persisted.cadence, this.overrides);
    this.state = initialState(Date.now());
    this.state.muted = persisted.muted ?? false;
    if (!persisted.active) return;

    this.active = true;
    this.baselineTools = withoutPairTools(persisted.baselineTools ?? this.pi.getActiveTools());
    await this.startWatching(ctx);
    applyRole(this.pi, this.role, this.baselineTools, this.config.extraReadOnlyTools);
  }

  private persist(): void {
    this.pi.appendEntry<PersistedState>(STATE_ENTRY, {
      active: this.active,
      cadence: this.config.cadence,
      role: this.role,
      muted: this.state.muted,
      overrides: this.overrides,
      baselineTools: this.baselineTools ?? [],
    });
  }

  private enqueueBurst(
    paths: string[],
    trigger: Trigger,
    ctx: ExtensionContext,
    command?: Observation["command"],
    question?: string,
  ): Promise<Decision> {
    const run = this.burstQueue.then(() => this.handleBurst(paths, trigger, ctx, command, question));
    this.burstQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async handleBurst(
    paths: string[],
    trigger: Trigger,
    ctx: ExtensionContext,
    command?: Observation["command"],
    question?: string,
  ): Promise<Decision> {
    const snapshot = this.snapshot;
    if (!this.active || !snapshot) return { observe: false, reason: "pair mode is off" };
    // In driver mode the agent is doing the editing; watching its own diffs
    // would be a feedback loop, not a pairing session. Its writes still go into
    // the baseline, so handing the keyboard back does not dump everything the
    // agent just wrote onto the navigator as if the driver had typed it.
    if (this.role === "driver" && trigger !== "manual") {
      if (paths.length > 0) await snapshot.commit(paths);
      return { observe: false, reason: "agent has the keyboard" };
    }

    const files = paths.length > 0 ? await snapshot.diff(paths) : [];
    const observation: Observation = {
      trigger,
      at: Date.now(),
      files,
      addedLines: files.reduce((sum, file) => sum + file.addedLines, 0),
      removedLines: files.reduce((sum, file) => sum + file.removedLines, 0),
      command,
    };
    let pending = this.pending;
    if (pending && paths.length > 0) {
      // A latest diff replaces an older held diff for every touched path. This
      // also removes a held change when the driver reverted it to the baseline.
      const touched = new Set(paths.map((path) => snapshot.toRelative(path)).filter((path) => path !== undefined));
      const remaining = pending.files.filter((file) => !touched.has(file.path));
      pending = {
        ...pending,
        files: remaining,
        addedLines: remaining.reduce((sum, file) => sum + file.addedLines, 0),
        removedLines: remaining.reduce((sum, file) => sum + file.removedLines, 0),
      };
    }
    const merged = pending ? mergeObservations(pending, observation) : observation;

    // Nothing changed and nothing to react to: not worth a round-trip.
    if (merged.files.length === 0 && !merged.command && trigger === "edit-burst") {
      this.pending = undefined;
      return { observe: false, reason: "nothing changed" };
    }

    const now = Date.now();
    const decision = this.busyReason(trigger, ctx) ?? shouldObserve(merged, this.state, this.config, now);
    if (!decision.observe) {
      // Held, not dropped: the next burst merges into this one.
      this.pending = merged;
      this.lastDecision = decision.reason;
      this.updateUi(ctx);
      return decision;
    }

    this.pending = undefined;
    if (trigger === "idle-nudge") this.state.lastIdleNudgeAt = now;
    recordObservation(this.state, now);
    // Advance the baseline for everything actually shown, not just the paths in
    // the burst that tripped the threshold: files folded in from earlier held
    // bursts have been shown too, and re-showing them makes the navigator
    // repeat itself.
    const shown = merged.files.map((file) => snapshot.toAbsolute(file.path));
    if (shown.length > 0) await snapshot.commit(shown);

    const body = renderObservation(merged, this.config.maxFilesPerObservation);
    const content = question ? `${body}\n\nThe driver also asked: ${question}` : body;

    this.observingSince = Date.now();
    if (trigger === "manual") {
      this.pi.sendUserMessage(content, ctx.isIdle() ? undefined : { deliverAs: "followUp" });
    } else {
      this.pi.sendMessage(
        {
          customType: OBSERVATION_MESSAGE,
          content,
          display: false,
          details: { trigger, files: merged.files.map((f) => f.path) },
        },
        { triggerTurn: true, deliverAs: "followUp" },
      );
    }
    this.lastDecision = "";
    this.updateUi(ctx);
    return decision;
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
    if (this.observing) return { observe: false, reason: "still thinking about the last look" };
    if (!ctx.isIdle()) return { observe: false, reason: "agent is mid-turn" };
    return undefined;
  }

  updateUi(ctx: ExtensionContext): void {
    if (!ctx.hasUI) return;
    if (!this.active) {
      ctx.ui.setWidget("pair", undefined);
      ctx.ui.setStatus("pair", undefined);
      return;
    }

    const bits = [
      this.role === "navigator" ? "navigator" : "DRIVING",
      this.config.cadence,
      this.state.muted ? "muted" : undefined,
    ].filter(Boolean);
    ctx.ui.setStatus("pair", `pair: ${bits.join(" · ")}`);

    const lines = [
      `pair ─ ${this.role === "navigator" ? "you drive, I watch" : "I have the keyboard"} (${this.config.cadence})`,
    ];
    if (this.pending) {
      const { addedLines, removedLines, files } = this.pending;
      lines.push(
        `  holding +${addedLines}/-${removedLines} in ${files.length} file(s)${this.lastDecision ? ` — ${this.lastDecision}` : ""}`,
      );
    } else if (this.lastDecision) {
      lines.push(`  ${this.lastDecision}`);
    }
    if (this.notes.length > 0) lines.push(`  ${this.notes.length} note(s) — /pair notes`);
    if (this.seedTruncated) lines.push("  repo too large to baseline fully — some first edits may look like new files");
    ctx.ui.setWidget("pair", lines);
  }
}
