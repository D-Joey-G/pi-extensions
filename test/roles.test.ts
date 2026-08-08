import assert from "node:assert/strict";
import { test } from "node:test";
import { isReadOnlyCommand, splitSegments } from "../src/roles.js";

test("inspection commands run without asking", () => {
  for (const command of [
    "git log --oneline -20",
    "git diff HEAD~1",
    "rg 'useEffect' src",
    "ls -la src",
    "npm test",
    "npx tsc --noEmit",
    "cat package.json | jq .scripts",
  ]) {
    assert.equal(isReadOnlyCommand(command), true, command);
  }
});

test("anything that can mutate the tree needs the driver's nod", () => {
  for (const command of [
    "rm -rf dist",
    "git commit -am wip",
    "git checkout main",
    "npm install lodash",
    "sed -i '' 's/a/b/' src/a.ts",
    "mkdir -p src/new",
  ]) {
    assert.equal(isReadOnlyCommand(command), false, command);
  }
});

test("a read-only prefix does not launder the rest of a compound command", () => {
  assert.equal(isReadOnlyCommand("cat a.ts && rm -rf src"), false);
  assert.equal(isReadOnlyCommand("ls; git push"), false);
  assert.equal(isReadOnlyCommand("git log | head -5"), true);
});

test("redirections and substitutions are treated as writes", () => {
  assert.equal(isReadOnlyCommand("cat a.ts > b.ts"), false);
  assert.equal(isReadOnlyCommand("echo hi >> notes.md"), false);
  assert.equal(isReadOnlyCommand("echo $(rm -rf /tmp/x)"), false);
});

test("segments split on every shell operator", () => {
  assert.deepEqual(splitSegments("ls && cat a || echo b; pwd"), ["ls", "cat a", "echo b", "pwd"]);
});
