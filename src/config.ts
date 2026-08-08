import type { Cadence } from "./types.js";

export interface PairConfig {
  cadence: Cadence;
  /** Quiet period after the last file change before the burst counts as settled. */
  settleMs: number;
  /** Minimum gap between two unsolicited interjections. */
  minGapMs: number;
  /** Cap on observations sent to the model per rolling hour. Each one costs a request. */
  maxObservationsPerHour: number;
  /** Bursts smaller than this are folded into the next one instead of waking the model. */
  minChangedLines: number;
  /** Offer help after this long with no edits. 0 disables the nudge. */
  idleNudgeMs: number;
  /** Truncate each file's patch to this many lines before sending. */
  maxPatchLines: number;
  /** Hard cap on files described in a single observation. */
  maxFilesPerObservation: number;
  /** Block every bash call outright instead of screening for read-only commands. */
  strictBash: boolean;
  /** Extra ignore globs on top of .gitignore and the built-in list. */
  ignore: string[];
}

const CADENCE_PRESETS: Record<
  Cadence,
  Pick<PairConfig, "settleMs" | "minGapMs" | "maxObservationsPerHour" | "minChangedLines" | "idleNudgeMs">
> = {
  // Speaks only when something looks genuinely worth flagging.
  quiet: { settleMs: 20_000, minGapMs: 10 * 60_000, maxObservationsPerHour: 12, minChangedLines: 25, idleNudgeMs: 0 },
  // Roughly the rhythm of a human pair: a remark every few minutes of work.
  normal: {
    settleMs: 8_000,
    minGapMs: 3 * 60_000,
    maxObservationsPerHour: 30,
    minChangedLines: 8,
    idleNudgeMs: 12 * 60_000,
  },
  // Reacts to almost every meaningful edit. Useful when learning a codebase.
  chatty: {
    settleMs: 4_000,
    minGapMs: 45_000,
    maxObservationsPerHour: 90,
    minChangedLines: 3,
    idleNudgeMs: 5 * 60_000,
  },
};

export const DEFAULT_IGNORE = [
  "**/node_modules/**",
  "**/.git/**",
  "**/dist/**",
  "**/build/**",
  "**/out/**",
  "**/coverage/**",
  "**/.next/**",
  "**/target/**",
  "**/__pycache__/**",
  "**/*.log",
  "**/*.lock",
  "**/package-lock.json",
  "**/.DS_Store",
];

export function makeConfig(cadence: Cadence = "normal", overrides: Partial<PairConfig> = {}): PairConfig {
  return {
    cadence,
    ...CADENCE_PRESETS[cadence],
    maxPatchLines: 200,
    maxFilesPerObservation: 12,
    strictBash: false,
    ignore: [],
    ...overrides,
  };
}

export function isCadence(value: string): value is Cadence {
  return value === "quiet" || value === "normal" || value === "chatty";
}
