import { isCadence, type PairConfig, sanitizeOverrides, toStringArray } from "./config.js";
import type { Cadence, PairNote, Role } from "./types.js";

export const NOTE_ENTRY = "pair/note";
export const STATE_ENTRY = "pair/state";

/** The session snapshot written to the transcript whenever the choice changes. */
export interface PersistedState {
  active: boolean;
  cadence: Cadence;
  role: Role;
  muted: boolean;
  overrides: Partial<PairConfig>;
  /** Absent in transcripts written before this was recorded; not the same as empty. */
  baselineTools?: string[];
  /** True while an agent-approved handoff is waiting for its run to settle. */
  returnAfterSettled: boolean;
}

/**
 * Reads a persisted session back, repairing anything that does not typecheck.
 *
 * Transcripts outlive the code that wrote them: a downgrade, a hand-edit, or a
 * cadence added in a later version all arrive here as ordinary data. Nothing
 * throws and nothing is trusted, because the failure is quiet rather than loud
 * — an unknown cadence reaches `makeConfig` as a missing preset, leaving
 * `minChangedLines` and the hourly budget `undefined`, and every comparison
 * against `undefined` is `false`, which the pacing code reads as "go ahead".
 * The driver's next keystroke would then buy a model request.
 */
export function parsePersistedState(data: unknown): PersistedState | undefined {
  if (!isRecord(data)) return undefined;
  return {
    // Anything other than a clear yes leaves pairing off; the driver can always
    // turn it back on, but a session that watches without being asked cannot be
    // undone after the fact.
    active: data.active === true,
    cadence: typeof data.cadence === "string" && isCadence(data.cadence) ? data.cadence : "normal",
    // An unrecognised role falls back to the one that cannot write.
    role: data.role === "driver" ? "driver" : "navigator",
    muted: data.muted === true,
    overrides: sanitizeOverrides(data.overrides),
    baselineTools: Array.isArray(data.baselineTools) ? toStringArray(data.baselineTools) : undefined,
    returnAfterSettled: data.returnAfterSettled === true,
  };
}

const NOTE_KINDS: ReadonlyArray<PairNote["kind"]> = ["decision", "question", "risk"];

/** Reads a persisted note, or undefined when the entry is not a usable one. */
export function parseNote(data: unknown): PairNote | undefined {
  if (!isRecord(data)) return undefined;
  const kind = NOTE_KINDS.find((known) => known === data.kind);
  if (kind === undefined || typeof data.text !== "string") return undefined;
  return { kind, text: data.text, at: typeof data.at === "number" && Number.isFinite(data.at) ? data.at : 0 };
}

/** Narrows to a plain object. An array is data, but it is never one of ours. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
