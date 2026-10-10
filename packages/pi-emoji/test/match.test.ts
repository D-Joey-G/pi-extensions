import assert from "node:assert/strict";
import { test } from "node:test";
import { type Entry, findToken, search } from "../src/match.ts";

const entry = (name: string, value = "x"): Entry => ({ name, value, kind: "emoji" });

test("findToken returns the :query before the cursor", () => {
  assert.equal(findToken("hi :smi", 7), ":smi");
  assert.equal(findToken("a (:tada", 8), ":tada");
  assert.equal(findToken(":elmo-fire", 10), ":elmo-fire");
});

test("findToken ignores colons that are not shortcodes", () => {
  assert.equal(findToken("http://x", 7), undefined);
  assert.equal(findToken("10:30", 5), undefined);
  assert.equal(findToken("foo::bar", 8), undefined);
  assert.equal(findToken(":a", 2), undefined);
});

test("search treats _ and - as the same and ranks exact, prefix, then substring", () => {
  const entries = [entry("big-fire"), entry("fire-engine"), entry("fire"), entry("thumbs-up")];
  assert.deepEqual(
    search(entries, ":fire").map((e) => e.name),
    ["fire", "fire-engine", "big-fire"],
  );
  assert.deepEqual(
    search(entries, ":thumbs_up").map((e) => e.name),
    ["thumbs-up"],
  );
});
