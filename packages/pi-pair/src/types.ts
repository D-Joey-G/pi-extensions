/** Which side of the keyboard the agent is on. */
export type Role = "navigator" | "driver";

/** How eagerly the navigator speaks up unprompted. */
export type Cadence = "quiet" | "normal" | "chatty";

/** What caused the navigator to look at the workspace. */
export type Trigger = "edit-burst" | "failed-command" | "idle-nudge" | "manual";

/** A single file the driver touched, with the diff since the navigator last looked. */
export interface ObservedFile {
  path: string;
  /** "added" | "modified" | "deleted" relative to the last observation. */
  status: "added" | "modified" | "deleted";
  /** Unified diff from last-observed content to current content. */
  patch: string;
  addedLines: number;
  removedLines: number;
}

/** A settled burst of driver edits, ready to show the navigator. */
export interface Observation {
  trigger: Trigger;
  at: number;
  files: ObservedFile[];
  addedLines: number;
  removedLines: number;
  /** Set for "failed-command": the command and its tail output. */
  command?: { command: string; exitCode: number; output: string };
}

/** Running tally the interjection policy reads and updates. */
export interface PolicyState {
  muted: boolean;
  /** Epoch ms of the last time the navigator actually said something. */
  lastInterjectionAt: number;
  /** Epoch ms of every observation sent to the model in the current hour window. */
  observationTimes: number[];
  /** Epoch ms of the last driver edit seen, used for the idle nudge. */
  lastEditAt: number;
  /** Epoch ms of the last idle nudge, so we nudge at most once per idle stretch. */
  lastIdleNudgeAt: number;
}

/** A design decision or open question recorded during the session. */
export interface PairNote {
  kind: "decision" | "question" | "risk";
  text: string;
  at: number;
}
