import assert from "node:assert/strict";
import { test } from "node:test";
import { makeConfig } from "../src/config.js";
import {
  initialState,
  mergeObservations,
  recordInterjection,
  recordObservation,
  shouldObserve,
} from "../src/policy.js";
import type { Observation, Trigger } from "../src/types.js";

const NOW = 1_700_000_000_000;

function observation(trigger: Trigger, added: number, removed = 0): Observation {
  return {
    trigger,
    at: NOW,
    files: [{ path: "src/a.ts", status: "modified", patch: "", addedLines: added, removedLines: removed }],
    addedLines: added,
    removedLines: removed,
  };
}

test("a trivial edit does not wake the model", () => {
  const config = makeConfig("normal");
  const state = initialState(NOW);
  const decision = shouldObserve(observation("edit-burst", 2), state, config, NOW);
  assert.equal(decision.observe, false);
});

test("a substantial edit does", () => {
  const config = makeConfig("normal");
  const state = initialState(NOW);
  assert.equal(shouldObserve(observation("edit-burst", 40), state, config, NOW).observe, true);
});

test("the gap clock runs from the last interjection, not the last look", () => {
  const config = makeConfig("normal");
  const state = initialState(NOW);
  recordInterjection(state, NOW);

  // One minute later, well inside the 3-minute normal gap.
  const soon = NOW + 60_000;
  assert.equal(shouldObserve(observation("edit-burst", 40), state, config, soon).observe, false);

  // Looking without speaking must not reset the gap.
  recordObservation(state, soon);
  assert.equal(shouldObserve(observation("edit-burst", 40), state, config, soon + 1000).observe, false);

  // Past the gap it may speak again.
  assert.equal(shouldObserve(observation("edit-burst", 40), state, config, NOW + 4 * 60_000).observe, true);
});

test("a failed command overrides the gap", () => {
  const config = makeConfig("normal");
  const state = initialState(NOW);
  recordInterjection(state, NOW);
  assert.equal(shouldObserve(observation("failed-command", 0), state, config, NOW + 1000).observe, true);
});

test("muting silences even urgent triggers", () => {
  const config = makeConfig("chatty");
  const state = initialState(NOW);
  state.muted = true;
  assert.equal(shouldObserve(observation("manual", 100), state, config, NOW).observe, false);
});

test("the hourly budget caps observations, including urgent ones", () => {
  const config = makeConfig("normal", { maxObservationsPerHour: 3 });
  const state = initialState(NOW);
  for (let i = 0; i < 3; i += 1) recordObservation(state, NOW + i);
  assert.equal(shouldObserve(observation("manual", 100), state, config, NOW + 10).observe, false);

  // The window rolls: an hour on, the budget is clear again.
  assert.equal(shouldObserve(observation("manual", 100), state, config, NOW + 60 * 60_000 + 1).observe, true);
});

test("the idle nudge waits for real idleness and fires once", () => {
  const config = makeConfig("normal");
  const state = initialState(NOW);

  assert.equal(shouldObserve(observation("idle-nudge", 0), state, config, NOW + 60_000).observe, false);

  const idle = NOW + config.idleNudgeMs + 1000;
  assert.equal(shouldObserve(observation("idle-nudge", 0), state, config, idle).observe, true);

  state.lastIdleNudgeAt = idle;
  assert.equal(shouldObserve(observation("idle-nudge", 0), state, config, idle + 60_000).observe, false);
});

test("quiet cadence disables the idle nudge entirely", () => {
  const config = makeConfig("quiet");
  const state = initialState(NOW);
  const decision = shouldObserve(observation("idle-nudge", 0), state, config, NOW + 60 * 60_000);
  assert.equal(decision.observe, false);
});

test("held-back bursts accumulate instead of being dropped", () => {
  const first: Observation = {
    trigger: "edit-burst",
    at: NOW,
    files: [{ path: "a.ts", status: "modified", patch: "", addedLines: 3, removedLines: 1 }],
    addedLines: 3,
    removedLines: 1,
  };
  const second: Observation = {
    trigger: "edit-burst",
    at: NOW + 1000,
    files: [
      // Same file edited again: the newer diff replaces the older one.
      { path: "a.ts", status: "modified", patch: "", addedLines: 6, removedLines: 2 },
      { path: "b.ts", status: "added", patch: "", addedLines: 10, removedLines: 0 },
    ],
    addedLines: 16,
    removedLines: 2,
  };

  const merged = mergeObservations(first, second);
  assert.equal(merged.files.length, 2);
  assert.equal(merged.addedLines, 16);
  assert.equal(merged.removedLines, 2);

  // Two small bursts that were each below threshold now clear it together.
  const config = makeConfig("normal");
  assert.equal(shouldObserve(merged, initialState(NOW), config, NOW + 2000).observe, true);
});
