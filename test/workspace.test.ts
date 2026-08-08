import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { makeConfig } from "../src/config.js";
import { countLines, truncatePatch, WorkspaceSnapshot } from "../src/workspace.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pair-test-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

test("the baseline is the tree at session start, not git HEAD", async () => {
  const file = join(root, "a.ts");
  await writeFile(file, "const a = 1;\n");

  const snapshot = new WorkspaceSnapshot(root, makeConfig());
  await snapshot.seed([file]);

  // Nothing has changed since we sat down, so there is nothing to report.
  assert.deepEqual(await snapshot.diff([file]), []);

  await writeFile(file, "const a = 1;\nconst b = 2;\n");
  const changes = await snapshot.diff([file]);
  assert.equal(changes.length, 1);
  assert.equal(changes[0]!.status, "modified");
  assert.equal(changes[0]!.addedLines, 1);
  assert.match(changes[0]!.patch, /\+const b = 2;/);
});

test("committing advances the baseline so diffs are not repeated", async () => {
  const file = join(root, "a.ts");
  await writeFile(file, "one\n");
  const snapshot = new WorkspaceSnapshot(root, makeConfig());
  await snapshot.seed([file]);

  await writeFile(file, "one\ntwo\n");
  assert.equal((await snapshot.diff([file])).length, 1);

  await snapshot.commit([file]);
  assert.deepEqual(await snapshot.diff([file]), []);

  await writeFile(file, "one\ntwo\nthree\n");
  const next = await snapshot.diff([file]);
  assert.equal(next.length, 1);
  // Only the newest line, not the whole history.
  assert.match(next[0]!.patch, /\+three/);
  assert.doesNotMatch(next[0]!.patch, /\+two/);
});

test("new and deleted files are classified", async () => {
  const snapshot = new WorkspaceSnapshot(root, makeConfig());
  const file = join(root, "new.ts");
  await snapshot.seed([]);

  await writeFile(file, "hello\n");
  const added = await snapshot.diff([file]);
  assert.equal(added[0]!.status, "added");

  await snapshot.commit([file]);
  await rm(file);
  const deleted = await snapshot.diff([file]);
  assert.equal(deleted[0]!.status, "deleted");
});

test("binary files are skipped rather than dumped into context", async () => {
  const file = join(root, "blob.bin");
  await writeFile(file, Buffer.from([0x00, 0x01, 0x02, 0x00]));
  const snapshot = new WorkspaceSnapshot(root, makeConfig());
  await snapshot.seed([]);
  assert.deepEqual(await snapshot.diff([file]), []);
});

test("paths outside the root are refused", async () => {
  const snapshot = new WorkspaceSnapshot(root, makeConfig());
  assert.deepEqual(await snapshot.diff(["/etc/hosts"]), []);
});

test("larger changes sort first so the cap keeps what matters", async () => {
  const small = join(root, "small.ts");
  const big = join(root, "big.ts");
  await writeFile(small, "");
  await writeFile(big, "");
  const snapshot = new WorkspaceSnapshot(root, makeConfig());
  await snapshot.seed([small, big]);

  await writeFile(small, "a\n");
  await writeFile(big, Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n"));
  const changes = await snapshot.diff([small, big]);
  assert.equal(changes[0]!.path, "big.ts");
});

test("patch line counting ignores the file headers", () => {
  const patch = ["--- a/x.ts", "+++ b/x.ts", "@@ -1 +1,2 @@", " keep", "+added", "-removed"].join("\n");
  assert.deepEqual(countLines(patch), { added: 1, removed: 1 });
});

test("oversized patches are truncated with a marker", () => {
  const patch = Array.from({ length: 300 }, (_, i) => `+line ${i}`).join("\n");
  const truncated = truncatePatch(patch, 100);
  assert.equal(truncated.split("\n").length, 101);
  assert.match(truncated, /200 more diff lines truncated/);
});
