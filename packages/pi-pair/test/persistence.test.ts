import assert from "node:assert/strict";
import { test } from "node:test";
import { parseNote, parsePersistedState } from "../src/persistence.js";

test("a well-formed entry survives the round trip unchanged", () => {
  const state = parsePersistedState({
    active: true,
    cadence: "chatty",
    role: "driver",
    muted: true,
    overrides: { minChangedLines: 42, extraReadOnlyTools: ["docs_search"] },
    baselineTools: ["read", "edit"],
    returnAfterSettled: true,
  });

  assert.deepEqual(state, {
    active: true,
    cadence: "chatty",
    role: "driver",
    muted: true,
    overrides: { minChangedLines: 42, extraReadOnlyTools: ["docs_search"] },
    baselineTools: ["read", "edit"],
    returnAfterSettled: true,
  });
});

test("fields that were optional in earlier versions still restore", () => {
  // What a transcript written before `muted` and `returnAfterSettled` existed
  // looks like. Losing the session over a field that was never written would
  // make every upgrade a silent reset.
  const state = parsePersistedState({ active: true, cadence: "quiet", role: "navigator", overrides: {} });

  assert.equal(state?.active, true);
  assert.equal(state?.cadence, "quiet");
  assert.equal(state?.muted, false);
  assert.equal(state?.returnAfterSettled, false);
  // Absent is not the same as empty: the caller falls back to the live tool set
  // rather than restoring the driver into a session with no tools at all.
  assert.equal(state?.baselineTools, undefined);
});

test("an unknown cadence falls back instead of leaving the pacing undefined", () => {
  // The failure this guards is quiet: an unknown preset leaves minChangedLines
  // and the hourly budget undefined, and every comparison against undefined is
  // false — which the pacing code reads as "go ahead".
  const state = parsePersistedState({ active: true, cadence: "breezy", role: "navigator" });
  assert.equal(state?.cadence, "normal");
});

test("an unrecognised role falls back to the one that cannot write", () => {
  assert.equal(parsePersistedState({ role: "root" })?.role, "navigator");
  assert.equal(parsePersistedState({ role: "driver" })?.role, "driver");
});

test("pairing only restores as active on an explicit yes", () => {
  assert.equal(parsePersistedState({ active: "yes" })?.active, false);
  assert.equal(parsePersistedState({ active: 1 })?.active, false);
  assert.equal(parsePersistedState({})?.active, false);
  assert.equal(parsePersistedState({ active: true })?.active, true);
});

test("overrides that are not usable settings are dropped, not repaired", () => {
  const state = parsePersistedState({
    overrides: {
      minChangedLines: "lots",
      settleMs: 1.5,
      maxPatchLines: -1,
      // Zero means "off" for the idle nudge and nothing sane anywhere else.
      maxObservationsPerHour: 0,
      idleNudgeMs: 0,
      maxFileBytes: 4096,
      ignore: ["*.snap", 7, null],
      unknownSetting: 3,
    },
  });

  assert.deepEqual(state?.overrides, { idleNudgeMs: 0, maxFileBytes: 4096, ignore: ["*.snap"] });
});

test("an entry that is not an object at all is simply absent", () => {
  assert.equal(parsePersistedState(undefined), undefined);
  assert.equal(parsePersistedState(null), undefined);
  assert.equal(parsePersistedState("active"), undefined);
  assert.equal(parsePersistedState([]), undefined);
});

test("a note is kept only when both of its meaningful fields are", () => {
  assert.deepEqual(parseNote({ kind: "risk", text: "no timeout", at: 5 }), {
    kind: "risk",
    text: "no timeout",
    at: 5,
  });
  // A missing timestamp is survivable; the note itself is the point.
  assert.equal(parseNote({ kind: "decision", text: "retry at the transport layer" })?.at, 0);
  assert.equal(parseNote({ kind: "nonsense", text: "x" }), undefined);
  assert.equal(parseNote({ kind: "risk" }), undefined);
  assert.equal(parseNote("risk"), undefined);
});
