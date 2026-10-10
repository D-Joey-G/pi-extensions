import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { makeConfig } from "../src/config.js";
import { EditWatcher } from "../src/watcher.js";

let root: string;
const watchers: EditWatcher[] = [];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pair-watch-"));
});

afterEach(async () => {
  await Promise.all(watchers.splice(0).map((w) => w.stop()));
  await rm(root, { recursive: true, force: true });
});

function makeWatcher(settleMs: number, onBurst: (paths: string[]) => void): EditWatcher {
  const watcher = new EditWatcher({ root, config: makeConfig("chatty", { settleMs }), onBurst });
  watchers.push(watcher);
  return watcher;
}

/** Watched paths relative to the temp root, so assertions read as filenames. */
function names(paths: string[]): string[] {
  return paths.map((path) => path.replace(`${root}/`, ""));
}

test("start resolves only once the initial scan is done, and reports the baseline", async () => {
  await writeFile(join(root, "a.ts"), "one\n");
  await mkdir(join(root, "node_modules", "dep"), { recursive: true });
  await writeFile(join(root, "node_modules", "dep", "index.js"), "vendor\n");

  const watcher = makeWatcher(200, () => {});
  const ready = await watcher.start();

  const seeded = names(ready.files);
  assert.ok(seeded.includes("a.ts"), `expected a.ts in ${JSON.stringify(seeded)}`);
  // The whole point of the ignore matcher: vendor trees never reach the baseline.
  assert.ok(!seeded.some((n) => n.includes("node_modules")), `node_modules leaked into ${JSON.stringify(seeded)}`);
});

test("an edit made immediately after start is not lost", async () => {
  await writeFile(join(root, "a.ts"), "one\n");
  const bursts: string[][] = [];
  const watcher = makeWatcher(300, (paths) => bursts.push(paths));
  await watcher.start();

  // No settling delay: this is the race that dropped edits before.
  await writeFile(join(root, "a.ts"), "one\ntwo\n");
  await new Promise((resolve) => setTimeout(resolve, 2500));

  assert.equal(bursts.length, 1);
  assert.deepEqual(names(bursts[0]!), ["a.ts"]);
});

test("rapid edits coalesce into one burst", async () => {
  const bursts: string[][] = [];
  const watcher = makeWatcher(600, (paths) => bursts.push(paths));
  await watcher.start();

  for (const name of ["a.ts", "b.ts", "c.ts"]) {
    await writeFile(join(root, name), "x\n");
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
  await new Promise((resolve) => setTimeout(resolve, 2500));

  assert.equal(bursts.length, 1, `expected one burst, got ${bursts.length}`);
  assert.deepEqual(names(bursts[0]!).sort(), ["a.ts", "b.ts", "c.ts"]);
});

test("ignored files never produce a burst", async () => {
  await mkdir(join(root, "dist"), { recursive: true });
  const bursts: string[][] = [];
  const watcher = makeWatcher(300, (paths) => bursts.push(paths));
  await watcher.start();

  await writeFile(join(root, "dist", "bundle.js"), "compiled\n");
  await new Promise((resolve) => setTimeout(resolve, 2000));

  assert.equal(bursts.length, 0);
});

test("flush emits pending edits without waiting for the settle window", async () => {
  const bursts: string[][] = [];
  const watcher = makeWatcher(60_000, (paths) => bursts.push(paths));
  await watcher.start();

  await writeFile(join(root, "a.ts"), "x\n");
  await new Promise((resolve) => setTimeout(resolve, 800));
  assert.equal(bursts.length, 0, "should still be settling");

  watcher.flush();
  assert.equal(bursts.length, 1);

  // Flushing an empty queue is a no-op rather than an empty burst.
  watcher.flush();
  assert.equal(bursts.length, 1);
});
