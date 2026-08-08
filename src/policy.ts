import type { PairConfig } from "./config.js";
import type { Observation, PolicyState, Trigger } from "./types.js";

const HOUR_MS = 60 * 60_000;

export function initialState(now: number): PolicyState {
  return {
    muted: false,
    lastInterjectionAt: 0,
    observationTimes: [],
    lastEditAt: now,
    lastIdleNudgeAt: 0,
  };
}

export type Decision = { observe: true } | { observe: false; reason: string };

/**
 * Decides whether an observation is worth waking the model for.
 *
 * The gap and budget checks are deliberately asymmetric: `minGapMs` is measured
 * from the last time the navigator actually *spoke*, so a run of "nothing to
 * say" observations doesn't buy the navigator the right to interrupt sooner,
 * while `maxObservationsPerHour` counts every model round-trip so a driver on a
 * tear can't run up the bill.
 */
export function shouldObserve(observation: Observation, state: PolicyState, config: PairConfig, now: number): Decision {
  if (state.muted) return { observe: false, reason: "muted" };

  // The driver asked directly, or something broke. Both bypass pacing.
  const urgent: Trigger[] = ["manual", "failed-command"];
  if (urgent.includes(observation.trigger)) {
    return withinBudget(state, config, now) ?? { observe: true };
  }

  if (observation.trigger === "idle-nudge") {
    if (config.idleNudgeMs <= 0) return { observe: false, reason: "idle nudge disabled" };
    if (now - state.lastEditAt < config.idleNudgeMs) return { observe: false, reason: "not idle long enough" };
    if (now - state.lastIdleNudgeAt < config.idleNudgeMs)
      return { observe: false, reason: "already nudged this stretch" };
    return withinBudget(state, config, now) ?? { observe: true };
  }

  const changed = observation.addedLines + observation.removedLines;
  if (changed < config.minChangedLines) {
    return { observe: false, reason: `only ${changed} changed lines (need ${config.minChangedLines})` };
  }

  const sinceSpoke = now - state.lastInterjectionAt;
  if (state.lastInterjectionAt > 0 && sinceSpoke < config.minGapMs) {
    return {
      observe: false,
      reason: `spoke ${Math.round(sinceSpoke / 1000)}s ago (gap ${Math.round(config.minGapMs / 1000)}s)`,
    };
  }

  return withinBudget(state, config, now) ?? { observe: true };
}

function withinBudget(state: PolicyState, config: PairConfig, now: number): Decision | undefined {
  const recent = state.observationTimes.filter((t) => now - t < HOUR_MS);
  if (recent.length >= config.maxObservationsPerHour) {
    return { observe: false, reason: `hourly observation budget reached (${config.maxObservationsPerHour})` };
  }
  return undefined;
}

/** Records that an observation was sent to the model. Mutates and returns state. */
export function recordObservation(state: PolicyState, now: number): PolicyState {
  state.observationTimes = state.observationTimes.filter((t) => now - t < HOUR_MS);
  state.observationTimes.push(now);
  return state;
}

/** Records that the navigator actually said something to the driver. */
export function recordInterjection(state: PolicyState, now: number): PolicyState {
  state.lastInterjectionAt = now;
  return state;
}

/** Merges a burst that was too small to act on into the next one. */
export function mergeObservations(pending: Observation, next: Observation): Observation {
  const byPath = new Map(pending.files.map((file) => [file.path, file]));
  for (const file of next.files) byPath.set(file.path, file);
  const files = [...byPath.values()];
  return {
    trigger: next.trigger,
    at: next.at,
    files,
    addedLines: files.reduce((sum, file) => sum + file.addedLines, 0),
    removedLines: files.reduce((sum, file) => sum + file.removedLines, 0),
    command: next.command ?? pending.command,
  };
}
