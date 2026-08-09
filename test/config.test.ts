import assert from "node:assert/strict";
import { test } from "node:test";
import { makeConfig, OVERRIDABLE_KEYS, parseOverride, renderConfig } from "../src/config.js";

test("numeric settings are parsed and range-checked", () => {
  const ok = parseOverride("minChangedLines", "20");
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.ok && ok.override, { minChangedLines: 20 });

  for (const bad of ["", "lots", "-1"]) {
    assert.equal(parseOverride("minChangedLines", bad).ok, false, bad);
  }
});

test("zero is only meaningful for the idle nudge", () => {
  // 0 disables the nudge; a zero budget or patch cap would silently switch the
  // navigator off while still reporting itself as on.
  assert.equal(parseOverride("idleNudgeMs", "0").ok, true);
  assert.equal(parseOverride("maxObservationsPerHour", "0").ok, false);
  assert.equal(parseOverride("maxPatchLines", "0").ok, false);
});

test("booleans take only true or false", () => {
  assert.deepEqual(parseOverride("strictBash", "true"), { ok: true, override: { strictBash: true } });
  assert.deepEqual(parseOverride("strictBash", "false"), { ok: true, override: { strictBash: false } });
  assert.equal(parseOverride("strictBash", "yes").ok, false);
});

test("list settings split on commas and drop blanks", () => {
  const parsed = parseOverride("ignore", "**/vendor/**, **/*.snap ,");
  assert.deepEqual(parsed.ok && parsed.override, { ignore: ["**/vendor/**", "**/*.snap"] });
});

test("an unknown key is refused by name", () => {
  const parsed = parseOverride("cadence", "chatty");
  assert.equal(parsed.ok, false);
  assert.match(parsed.ok === false ? parsed.error : "", /Unknown setting "cadence"/);
});

test("every overridable key round-trips into the config", () => {
  // Guards against a key being listed but not actually applied by makeConfig.
  const config = makeConfig("normal");
  for (const key of OVERRIDABLE_KEYS) {
    assert.equal(key in config, true, key);
  }
});

test("the rendered config shows every knob", () => {
  const rendered = renderConfig(makeConfig("quiet", { ignore: ["**/vendor/**"] }));
  assert.match(rendered, /cadence {2}quiet/);
  assert.match(rendered, /strictBash\s+false/);
  assert.match(rendered, /ignore\s+\*\*\/vendor\/\*\*/);
  // Empty lists read as a dash rather than as nothing at all.
  assert.match(rendered, /extraReadOnlyTools\s+—/);
});
