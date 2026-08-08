import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { makeConfig, type PairConfig } from "./config.js";
import { initialState, mergeObservations, recordInterjection, recordObservation, shouldObserve } from "./policy.js";
import { DRIVER_HANDOFF_PROMPT, NAVIGATOR_PROMPT, notesContext, renderObservation } from "./prompts.js";
import { applyRole } from "./roles.js";
import type { Cadence, Observation, PairNote, PolicyState, Role, Trigger } from "./types.js";
import { EditWatcher } from "./watcher.js";
import { WorkspaceSnapshot } from "./workspace.js";

export const NOTE_ENTRY = "pair/note";
export const STATE_ENTRY = "pair/state";
export const OBSERVATION_MESSAGE = "pair/observation";

interface PersistedState {
  active: boolean;
  cadence: Cadence;
  role: Role;
}

/**
 * Owns the pairing session: what the driver changed, whether it is worth a
 * remark, and which role each side is currently playing.
 */
export class PairController {
  private config: PairConfig = makeConfig();
  private state: PolicyState = initialState(Date.now());
  private role: Role = "navigator";
  private active = false;
  private watcher: EditWatcher | undefined;
  private snapshot: WorkspaceSnapshot | undefined;
  private baselineTools: string[] = [];
  private notes: PairNote[] = [];
  private pending: Observation | undefined;
  /** Set while an observation is in flight so bursts do not stack up. */
  private observing = false;
  private lastDecision = "";
  /** True when the repo was too large to baseline fully at startup. */
  private seedTruncated = false;

  constructor(private readonly pi: ExtensionAPI) {}

  get isActive(): boolean {
    return this.active;
  }

  get currentRole(): Role {
    return this.role;
  }

  get currentCadence(): Cadence {
    return this.config.cadence;
  }

  get isMuted(): boolean {
    return this.state.muted;
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
    this.config = makeConfig(cadence, overrides);
    this.state = initialState(Date.now());
    this.role = "navigator";
    this.active = true;
    this.baselineTools = this.pi.getActiveTools();

    this.snapshot = new WorkspaceSnapshot(ctx.cwd, this.config);
    this.watcher = new EditWatcher(
      ctx.cwd,
      this.config,
      (burst) => {
        void this.handleBurst(burst.paths, "edit-burst", ctx);
      },
      (at) => {
        this.state.lastEditAt = at;
      },
    );
    // Await the initial scan before taking the baseline: edits made while
    // chokidar is still walking the tree would otherwise be invisible, and an
    // unseeded snapshot reports the first touched file as wholly new.
    const ready = await this.watcher.start();
    await this.snapshot.seed(ready.files);
    this.seedTruncated = ready.truncated;

    applyRole(this.pi, this.role, this.baselineTools);
    this.persist();
    this.updateUi(ctx);
  }

  async stop(ctx: ExtensionContext | undefined): Promise<void> {
    this.active = false;
    await this.watcher?.stop();
    this.watcher = undefined;
    this.snapshot = undefined;
    this.pending = undefined;
    if (this.baselineTools.length > 0) this.pi.setActiveTools(this.baselineTools);
    this.persist();
    if (ctx?.hasUI) {
      ctx.ui.setWidget("pair", undefined);
      ctx.ui.setStatus("pair", undefined);
    }
  }

  setCadence(cadence: Cadence, ctx: ExtensionContext): void {
    this.config = makeConfig(cadence, { strictBash: this.config.strictBash, ignore: this.config.ignore });
    this.persist();
    this.updateUi(ctx);
  }

  setMuted(muted: boolean, ctx: ExtensionContext): void {
    this.state.muted = muted;
    this.updateUi(ctx);
  }

  setRole(role: Role, ctx: ExtensionContext): void {
    this.role = role;
    applyRole(this.pi, role, this.baselineTools);
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

  /** Records that the driver's shell command failed, which always earns a look. */
  async reportFailedCommand(command: string, exitCode: number, output: string, ctx: ExtensionContext): Promise<void> {
    if (!this.active || this.role !== "navigator") return;
    await this.handleBurst([], "failed-command", ctx, { command, exitCode, output });
  }

  /** Forces a look right now, regardless of pacing. Used by `/pair look`. */
  async lookNow(ctx: ExtensionContext, question?: string): Promise<void> {
    if (!this.active) return;
    this.watcher?.flush();
    await this.handleBurst([], "manual", ctx, undefined, question);
  }

  /** Checks whether the driver has gone quiet long enough to offer help. */
  async maybeNudge(ctx: ExtensionContext): Promise<void> {
    if (!this.active || this.role !== "navigator") return;
    await this.handleBurst([], "idle-nudge", ctx);
  }

  restore(ctx: ExtensionContext): void {
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom") continue;
      if (entry.customType === NOTE_ENTRY && entry.data) this.notes.push(entry.data as PairNote);
      if (entry.customType === STATE_ENTRY && entry.data) {
        const persisted = entry.data as PersistedState;
        this.role = persisted.role;
        this.config = makeConfig(persisted.cadence);
      }
    }
  }

  private persist(): void {
    this.pi.appendEntry<PersistedState>(STATE_ENTRY, {
      active: this.active,
      cadence: this.config.cadence,
      role: this.role,
    });
  }

  private async handleBurst(
    paths: string[],
    trigger: Trigger,
    ctx: ExtensionContext,
    command?: Observation["command"],
    question?: string,
  ): Promise<void> {
    if (!this.active || !this.snapshot) return;
    // In driver mode the agent is doing the editing; watching its own diffs
    // would be a feedback loop, not a pairing session.
    if (this.role === "driver" && trigger !== "manual") return;
    if (this.observing) return;

    const files = paths.length > 0 ? await this.snapshot.diff(paths) : [];
    const observation: Observation = {
      trigger,
      at: Date.now(),
      files,
      addedLines: files.reduce((sum, file) => sum + file.addedLines, 0),
      removedLines: files.reduce((sum, file) => sum + file.removedLines, 0),
      command,
    };
    const merged = this.pending ? mergeObservations(this.pending, observation) : observation;

    // Nothing changed and nothing to react to: not worth a round-trip.
    if (merged.files.length === 0 && !merged.command && trigger === "edit-burst") return;

    const now = Date.now();
    const decision = shouldObserve(merged, this.state, this.config, now);
    if (!decision.observe) {
      this.pending = merged;
      this.lastDecision = decision.reason;
      this.updateUi(ctx);
      return;
    }

    this.pending = undefined;
    this.observing = true;
    if (trigger === "idle-nudge") this.state.lastIdleNudgeAt = now;
    recordObservation(this.state, now);
    // Advance the baseline now: these lines have been shown, and re-showing
    // them on the next burst would make the navigator repeat itself.
    if (paths.length > 0) await this.snapshot.commit(paths);

    const body = renderObservation(merged, this.config.maxFilesPerObservation);
    const content = question ? `${body}\n\nThe driver also asked: ${question}` : body;

    try {
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
    } finally {
      this.observing = false;
      this.lastDecision = "";
      this.updateUi(ctx);
    }
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
    }
    if (this.notes.length > 0) lines.push(`  ${this.notes.length} note(s) — /pair notes`);
    if (this.seedTruncated) lines.push("  repo too large to baseline fully — some first edits may look like new files");
    ctx.ui.setWidget("pair", lines);
  }
}
