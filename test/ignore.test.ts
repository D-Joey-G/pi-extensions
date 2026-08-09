import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_IGNORE } from "../src/config.js";
import { globToRegExp, makeIgnoreMatcher, makeWorkspaceIgnoreMatcher } from "../src/ignore.js";

const ROOT = "/repo";

test("the default ignore list actually excludes build and vendor noise", () => {
  const ignored = makeIgnoreMatcher(ROOT, DEFAULT_IGNORE);
  for (const path of [
    "/repo/node_modules/react/index.js",
    "/repo/packages/app/node_modules/x/y.js",
    "/repo/.git/HEAD",
    "/repo/dist/bundle.js",
    "/repo/coverage/lcov.info",
    "/repo/target/debug/app",
    "/repo/src/__pycache__/mod.pyc",
    "/repo/npm-debug.log",
    "/repo/package-lock.json",
    "/repo/.DS_Store",
  ]) {
    assert.equal(ignored(path), true, path);
  }
});

test("source files are not ignored", () => {
  const ignored = makeIgnoreMatcher(ROOT, DEFAULT_IGNORE);
  for (const path of [
    "/repo/src/index.ts",
    "/repo/README.md",
    "/repo/packages/app/src/server.ts",
    // A directory merely named like a build dir deeper in a source path.
    "/repo/src/distribution/index.ts",
  ]) {
    assert.equal(ignored(path), false, path);
  }
});

test("anything outside the root is ignored", () => {
  const ignored = makeIgnoreMatcher(ROOT, []);
  assert.equal(ignored("/etc/passwd"), true);
  assert.equal(ignored("/repo/src/a.ts"), false);
});

test("user-supplied globs are honoured", () => {
  const ignored = makeIgnoreMatcher(ROOT, ["**/*.snap", "fixtures/**"]);
  assert.equal(ignored("/repo/test/a.snap"), true);
  assert.equal(ignored("/repo/fixtures/big/data.json"), true);
  assert.equal(ignored("/repo/src/a.ts"), false);
});

test("root and nested .gitignore rules are honoured", async () => {
  const root = await mkdtemp(join(tmpdir(), "pair-ignore-"));
  try {
    await mkdir(join(root, "packages", "app"), { recursive: true });
    await writeFile(join(root, ".gitignore"), "*.env\nroot-only.txt\n");
    await writeFile(join(root, "packages", "app", ".gitignore"), "generated/\n!generated/keep.ts\n");
    const ignored = await makeWorkspaceIgnoreMatcher(root, []);

    assert.equal(ignored(join(root, "secret.env")), true);
    assert.equal(ignored(join(root, "packages", "app", "secret.env")), true);
    assert.equal(ignored(join(root, "root-only.txt")), true);
    assert.equal(ignored(join(root, "packages", "app", "generated")), true);
    assert.equal(ignored(join(root, "packages", "app", "src", "index.ts")), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("glob translation handles the segment-crossing cases", () => {
  assert.equal(globToRegExp("**/node_modules/**").test("node_modules/x"), true);
  assert.equal(globToRegExp("**/node_modules/**").test("a/b/node_modules/x/y"), true);
  assert.equal(globToRegExp("**/node_modules/**").test("src/node_modules_helper.ts"), false);
  // A single star must not cross a separator.
  assert.equal(globToRegExp("*.log").test("app.log"), true);
  assert.equal(globToRegExp("*.log").test("logs/app.log"), false);
  // Regex metacharacters in patterns are literal.
  assert.equal(globToRegExp("a.b.c").test("a.b.c"), true);
  assert.equal(globToRegExp("a.b.c").test("axbxc"), false);
});
