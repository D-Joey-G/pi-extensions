import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { makeConfig, type PairConfig } from "./config.js";
import { NOTE_ENTRY, parseNote, parsePersistedState, type PersistedState, STATE_ENTRY } from "./persistence.js";
import type { Decision } from "./policy.js";
import { DRIVER_HANDOFF_PROMPT, NAVIGATOR_PROMPT, notesContext } from "./prompts.js";
import { applyRole, withoutPairTools } from "./roles.js";
import { PAIR_OFF, PairSession, type SessionDeps } from "./session.js";
import type { Cadence, PairNote, Role } from "./types.js";
import type { OpenWatcher } from "./watcher.js";

export interface ControllerHooks {
  /** Surfaces a watcher failure, which otherwise ends pairing silently. */
  onWatcherError?: (error: Error, ctx: ExtensionContext) => void;
  /** Surfaces a look that failed on its own, which nothing else would report. */
  onLookError?: (error: Error, ctx: ExtensionContext) => void;
}

/** Collaborators with a real implementation, substituted only by tests. */
export interface ControllerSeams {
  now?: () => number;
  openWatcher?: OpenWatcher;
}

/**
 * Owns the pairing session: what the driver changed, whether it is worth a
 * remark, and which role each side is currently playing.
 *
 * The observation machinery lives in `PairSession`; what stays here is the part
 * that outlives it — the role, the settings, the notes, and the transcript.
 */
export class PairController {
  private overrides: Partial<PairConfig> = {};
  private config: PairConfig = makeConfig();
  private role: Role = "navigator";
  /** Agent-approved handoffs return the keyboard after the scoped run settles. */
  private returnAfterSettled = false;
  /**
   * The driver's on/off choice, and the only half of "is pairing on" that is
   * persisted.
   *
   * Kept apart from `session`, which is the runtime serving that choice:
   * shutdown drops the runtime and leaves the choice alone, which is how a
   * reload comes back pairing instead of quietly switched off.
   */
  private active = false;
  /** The live runtime, present exactly while pairing is running. */
  private session: PairSession | undefined;
  /** Undefined until a session captures it; distinct from "captured as empty". */
  private baselineTools: string[] | undefined;
  private notes: PairNote[] = [];
  private readonly now: () => number;

  constructor(
    private readonly pi: ExtensionAPI,
    private readonly hooks: ControllerHooks = {},
    private readonly seams: ControllerSeams = {},
  ) {
    this.now = seams.now ?? Date.now;
  }

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
    return this.session?.muted ?? false;
  }

  get sessionNotes(): readonly PairNote[] {
    return this.notes;
  }

  /** The system prompt fragment for the current role, or undefined when off. */
  systemPromptSuffix(): string | undefined {
    if (!this.active) return undefined;
    const base = this.role === "navigator" ? NAVIGATOR_PROMPT : DRIVER_HANDOFF_PROMPT;
    return `${base}${notesContext(this.notes)}`;
  }

  async start(ctx: ExtensionContext, cadence: Cadence, overrides: Partial<PairConfig> = {}): Promise<void> {
    // Starting over a runtime that is already up would strand its watcher. This
    // also puts the previous tool set back before the new baseline is taken.
    await this.dispose(ctx);

    this.overrides = { ...overrides };
    this.config = makeConfig(cadence, this.overrides);
    this.role = "navigator";
    this.returnAfterSettled = false;
    this.baselineTools = withoutPairTools(this.pi.getActiveTools());

    try {
      this.session = await PairSession.start(this.sessionDeps(), ctx);
    } catch (error) {
      // Nothing is watching, so the transcript must not claim otherwise: a
      // reload would try to restore a session that never came up.
      this.active = false;
      await this.dispose(ctx);
      this.persist();
      throw error;
    }

    this.active = true;
    applyRole(this.pi, this.role, this.baselineTools, this.config.extraReadOnlyTools);
    this.persist();
    this.updateUi(ctx);
  }

  /** Releases the runtime without changing the persisted on/off choice. */
  async dispose(ctx: ExtensionContext | undefined): Promise<void> {
    const session = this.session;
    this.session = undefined;
    await session?.close();
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
    this.applyConfig(makeConfig(cadence, this.overrides));
    this.persist();
    this.updateUi(ctx);
  }

  /** Applies `/pair set` values on top of the current cadence preset. */
  async setOverrides(overrides: Partial<PairConfig>, ctx: ExtensionContext): Promise<void> {
    const ignoreChanged = overrides.ignore !== undefined;
    this.overrides = { ...this.overrides, ...overrides };
    this.applyConfig(makeConfig(this.config.cadence, this.overrides));
    if (this.session && this.baselineTools !== undefined) {
      // extraReadOnlyTools feeds the active tool set, so re-derive it.
      applyRole(this.pi, this.role, this.baselineTools, this.config.extraReadOnlyTools);
      if (ignoreChanged) await this.session.restartWatcher();
    }
    this.persist();
    this.updateUi(ctx);
  }

  setMuted(muted: boolean, ctx: ExtensionContext): void {
    this.session?.setMuted(muted);
    this.persist();
    this.updateUi(ctx);
  }

  setRole(role: Role, ctx: ExtensionContext, options: { returnAfterSettled?: boolean } = {}): void {
    // Anything held from before the handoff describes a tree the agent is about
    // to rewrite, so the patches would be stale by the time they were shown.
    if (role === "driver") this.session?.dropPending();
    this.role = role;
    this.returnAfterSettled = role === "driver" && options.returnAfterSettled === true;
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
    this.session?.noteInterjection();
    this.updateUi(ctx);
  }

  /** Records a silent look; its compact tool row is the only visible verdict. */
  noteQuiet(_reason: string | undefined, ctx: ExtensionContext): void {
    this.session?.noteQuiet();
    this.updateUi(ctx);
  }

  /** Frees the in-flight flag and completes any agent-approved keyboard handoff. */
  noteAgentSettled(ctx: ExtensionContext): boolean {
    const shouldReturn = this.role === "driver" && this.returnAfterSettled;
    if (shouldReturn) this.setRole("navigator", ctx);
    if (this.session?.noteAgentSettled()) this.updateUi(ctx);
    return shouldReturn;
  }

  /**
   * Handles a settled burst of driver edits. This is the watcher's entry point,
   * kept public so a caller can hand over paths directly without waiting on the
   * filesystem.
   */
  observeEdits(paths: string[], ctx: ExtensionContext): Promise<Decision> {
    return this.session?.observeEdits(paths, ctx) ?? Promise.resolve(PAIR_OFF);
  }

  /**
   * Records that the driver's shell command failed, which always earns a look.
   *
   * Nothing awaits this — it happens inside pi's bash backend — so a failure
   * here is reported through `onLookError` rather than raised at the caller.
   */
  reportFailedCommand(command: string, exitCode: number, output: string, ctx: ExtensionContext): void {
    this.session?.reportFailedCommand({ command, exitCode, output }, ctx);
  }

  /** Forces a look right now, regardless of pacing. Used by `/pair look`. */
  lookNow(ctx: ExtensionContext, question?: string): Promise<Decision> {
    return this.session?.lookNow(ctx, question) ?? Promise.resolve(PAIR_OFF);
  }

  /**
   * Rebuilds the session from the transcript.
   *
   * Notes always come back. The rest only matters when pairing was on when the
   * session ended, in which case the runtime is brought back up too — restoring
   * the label without the machinery would leave the widget claiming to watch a
   * tree nothing is watching.
   */
  async restore(ctx: ExtensionContext): Promise<void> {
    let persisted: PersistedState | undefined;
    // Rebuilt from the transcript each time, so a second session_start cannot
    // double up the notes.
    this.notes = [];
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom") continue;
      if (entry.customType === NOTE_ENTRY) {
        const note = parseNote(entry.data);
        if (note) this.notes.push(note);
      }
      // A state entry that cannot be read leaves the previous one standing,
      // which is a better answer than pretending the session never paired.
      if (entry.customType === STATE_ENTRY) persisted = parsePersistedState(entry.data) ?? persisted;
    }
    if (!persisted) return;

    // An automatic handoff belongs to the agent run that requested it. If that
    // run did not settle before shutdown, do not restore a stale permission.
    this.role = persisted.returnAfterSettled ? "navigator" : persisted.role;
    this.returnAfterSettled = false;
    this.overrides = persisted.overrides;
    this.config = makeConfig(persisted.cadence, this.overrides);
    if (!persisted.active) return;

    this.active = true;
    this.baselineTools = withoutPairTools(persisted.baselineTools ?? this.pi.getActiveTools());
    this.session = await PairSession.start(this.sessionDeps(), ctx, persisted.muted);
    applyRole(this.pi, this.role, this.baselineTools, this.config.extraReadOnlyTools);
  }

  updateUi(ctx: ExtensionContext): void {
    if (!ctx.hasUI) return;
    const session = this.session;
    if (!session) {
      ctx.ui.setWidget("pair", undefined);
      ctx.ui.setStatus("pair", undefined);
      return;
    }

    const bits = [
      this.role === "navigator" ? "navigator" : "DRIVING",
      this.config.cadence,
      session.muted ? "muted" : undefined,
    ].filter(Boolean);
    ctx.ui.setStatus("pair", `pair: ${bits.join(" · ")}`);

    // The footer owns steady-state role/cadence. Keep the larger widget for
    // actionable or exceptional state so the same information is not repeated
    // in three places.
    const lines: string[] = [];
    if (session.pending) {
      const { addedLines, removedLines, files, command } = session.pending.observation;
      const scope = command
        ? files.length > 0
          ? `failed command · +${addedLines}/-${removedLines} · ${files.length} file(s)`
          : "failed command"
        : `holding +${addedLines}/-${removedLines} · ${files.length} file(s)`;
      lines.push(`pair · ${scope}${session.pending.reason ? ` · ${session.pending.reason}` : ""}`);
    }
    if (session.seedTruncated) lines.push("pair · baseline truncated · some first edits may appear new");
    ctx.ui.setWidget("pair", lines.length > 0 ? lines : undefined);
  }

  private sessionDeps(): SessionDeps {
    return {
      pi: this.pi,
      config: this.config,
      now: this.now,
      role: () => this.role,
      openWatcher: this.seams.openWatcher,
      onChanged: (ctx) => this.updateUi(ctx),
      onWatcherFailed: (error, ctx) => void this.handleWatcherFailure(error, ctx),
      onLookFailed: (error, ctx) => this.hooks.onLookError?.(error, ctx),
    };
  }

  private async handleWatcherFailure(error: Error, ctx: ExtensionContext): Promise<void> {
    // Tear the runtime down before saying anything, so the status the driver
    // reads alongside the message is already the truth.
    try {
      await this.stop(ctx);
    } catch {
      // Teardown is best-effort. The failure being reported is the news.
    }
    this.hooks.onWatcherError?.(error, ctx);
  }

  /**
   * Replaces the settings in place.
   *
   * The watcher and the snapshot hold this same object, which is what lets a
   * cadence change or a `/pair set` take effect without restarting either.
   * Assigning a fresh object here would leave both of them on the old settings.
   */
  private applyConfig(next: PairConfig): void {
    Object.assign(this.config, next);
  }

  private persist(): void {
    this.pi.appendEntry<PersistedState>(STATE_ENTRY, {
      active: this.active,
      cadence: this.config.cadence,
      role: this.role,
      muted: this.session?.muted ?? false,
      overrides: this.overrides,
      baselineTools: this.baselineTools ?? [],
      returnAfterSettled: this.returnAfterSettled,
    });
  }
}
