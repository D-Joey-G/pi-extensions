import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  BUILTIN_MODES_DIR,
  DEFAULT_MODEL,
  discoverModes,
  expandModelAlias,
  findMode,
  modeDirs,
  parseMode,
  resolveLaunch,
  resolveSkill,
  type Mode,
} from "../src/modes.ts";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "agent-modes-test-"));
}

function modeFile(dir: string, file: string, frontmatter: string, body = "Prompt."): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, file);
  writeFileSync(path, `---\n${frontmatter}\n---\n\n${body}\n`);
  return path;
}

test("parseMode reads fields, list or comma tools, and resolves skill paths against the file", () => {
  const mode = parseMode(
    "/modes/x.md",
    "---\nname: x\ndescription: Does x\nmodel: openai/gpt-6.1-terra:high\nreadOnly: false\ntools: read, bash\nskills: [commit, ./skills/foo]\n---\n\nBe x.\n",
  );
  assert.deepEqual(mode, {
    name: "x",
    description: "Does x",
    model: "openai/gpt-6.1-terra:high",
    readOnly: false,
    tools: ["read", "bash"],
    skills: ["commit", "/modes/skills/foo"],
    prompt: "Be x.",
    path: "/modes/x.md",
  });
});

test("parseMode names the file and the problem", () => {
  const cases: [string, RegExp][] = [
    ["Just text.", /name is required/],
    ["---\nname: x\n---\n", /description is required/],
    ["---\nname: x\ndescription: d\nthinking: high\n---\n", /unknown field\(s\) thinking/],
    ["---\nname: x\ndescription: d\nreadOnly: yes please\n---\n", /readOnly must be true or false/],
    ["---\nname: x\ndescription: d\ntools: [1, 2]\n---\n", /tools must be a list of strings/],
    ["---\nname: [unclosed\n---\n", /Invalid agent mode \/m\/bad\.md: /],
  ];
  for (const [content, pattern] of cases) {
    assert.throws(
      () => parseMode("/m/bad.md", content),
      (err: Error) => {
        assert.match(err.message, /^Invalid agent mode \/m\/bad\.md: /);
        assert.match(err.message, pattern);
        return true;
      },
    );
  }
});

test("discoverModes: later directories win by name, malformed files are reported not fatal", () => {
  const root = tempDir();
  const user = join(root, "user");
  const project = join(root, "project");
  modeFile(user, "scout.md", "name: scout\ndescription: user scout\nmodel: a/b");
  modeFile(user, "extra.md", "name: extra\ndescription: user extra");
  modeFile(project, "s.md", "name: scout\ndescription: project scout");
  modeFile(project, "broken.md", "name: broken");

  const catalog = discoverModes([BUILTIN_MODES_DIR, user, join(root, "missing"), project]);
  assert.equal(catalog.modes.get("scout")?.description, "project scout");
  assert.equal(catalog.modes.get("scout")?.model, undefined);
  assert.equal(catalog.modes.get("extra")?.description, "user extra");
  assert.ok(catalog.modes.has("worker") && catalog.modes.has("review"));
  assert.equal(catalog.problems.length, 1);
  assert.match(catalog.problems[0], /broken\.md: description is required/);
  assert.throws(() => findMode(catalog, "broken"), /Unknown agent mode "broken"[\s\S]*broken\.md/);
});

test("built-in modes parse with the expected models and access", () => {
  const { modes, problems } = discoverModes([BUILTIN_MODES_DIR]);
  assert.deepEqual(problems, []);
  const summary = [...modes.values()].map((m) => [m.name, m.model, m.readOnly]).sort();
  assert.deepEqual(summary, [
    ["review", "claude-bridge/claude-opus-5-5:high", true],
    ["scout", "openai/gpt-6.1-terra", true],
    ["worker", "openai/gpt-6.2-sol", false],
  ]);
});

test("modeDirs includes the project directory only when given a cwd", () => {
  assert.deepEqual(modeDirs("/agent", undefined), [BUILTIN_MODES_DIR, "/agent/agent-modes"]);
  assert.deepEqual(modeDirs("/agent", "/repo"), [BUILTIN_MODES_DIR, "/agent/agent-modes", "/repo/.pi/agent-modes"]);
});

const mode: Mode = {
  name: "m",
  description: "d",
  model: "x/mode-model",
  readOnly: false,
  tools: ["read", "edit"],
  skills: ["commit"],
  prompt: "Role.",
  path: "/m.md",
};

test("resolveLaunch: no mode gives today's defaults", () => {
  assert.deepEqual(resolveLaunch({}, undefined), {
    model: DEFAULT_MODEL,
    readOnly: true,
    tools: "read,bash,ffgrep,fffind,write,intercom",
    skills: [],
    prompt: "",
  });
  assert.equal(resolveLaunch({ readOnly: false }, undefined).tools, "+intercom,-agent");
});

test("resolveLaunch: the mode fills unset args, and each explicit arg overrides its field", () => {
  assert.deepEqual(resolveLaunch({}, mode), {
    model: "x/mode-model",
    readOnly: false,
    tools: "read,edit,write,intercom",
    skills: ["commit"],
    prompt: "Role.",
  });
  const overridden = resolveLaunch({ model: "y/arg", readOnly: true, tools: ["read"], skills: [] }, mode);
  assert.deepEqual(overridden, {
    model: "y/arg",
    readOnly: true,
    tools: "read,write,intercom",
    skills: [],
    prompt: "Role.",
  });
  const { tools: _tools, ...noTools } = mode;
  assert.equal(resolveLaunch({ readOnly: true }, noTools).tools, "read,bash,ffgrep,fffind,write,intercom");
});

test("resolveSkill maps names through the known skills and paths against the base", () => {
  const root = tempDir();
  modeFile(join(root, "dir-skill"), "SKILL.md", "name: s\ndescription: d");
  const known = new Map([["commit", "/skills/commit/SKILL.md"]]);
  assert.equal(resolveSkill("commit", root, known), "/skills/commit/SKILL.md");
  assert.equal(resolveSkill("./dir-skill", root, known), join(root, "dir-skill", "SKILL.md"));
  assert.equal(resolveSkill(join(root, "dir-skill", "SKILL.md"), "/", known), join(root, "dir-skill", "SKILL.md"));
  assert.throws(() => resolveSkill("nope", root, known), /Unknown skill "nope". Known: commit/);
  assert.throws(() => resolveSkill("./missing", root, known), /Skill path does not exist/);
});

test("model aliases expand, keep a thinking suffix, and apply to modes and args alike", () => {
  assert.equal(expandModelAlias("opus"), "claude-bridge/claude-opus-5-5");
  assert.equal(expandModelAlias("sonnet:high"), "claude-bridge/claude-sonnet-5-5:high");
  assert.equal(expandModelAlias("openai/gpt-6.2-sol"), "openai/gpt-6.2-sol");
  assert.equal(resolveLaunch({ model: "opus" }, mode).model, "claude-bridge/claude-opus-5-5");
  assert.equal(resolveLaunch({}, { ...mode, model: "sol" }).model, "openai/gpt-6.2-sol");
});
