import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { PairController } from "../src/controller.js";

let root: string;
/** Started controllers hold a live watcher, which would keep node running. */
let started: Array<{ controller: PairController; ctx: ExtensionContext }> = [];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pair-controller-"));
  started = [];
});

afterEach(async () => {
  for (const { controller, ctx } of started) await controller.stop(ctx);
  started = [];
  await rm(root, { recursive: true, force: true });
});

/** Builds a controller and guarantees its watcher is torn down after the test. */
function makeController(api: ReturnType<typeof fakePi>, ctx: ExtensionContext): PairController {
  const controller = new PairController(api.pi);
  started.push({ controller, ctx });
  return controller;
}

interface SentMessage {
  content: string;
  kind: "custom" | "user";
}

/** The slice of the pi API the controller actually touches. */
function fakePi(baseline: string[] = ["read", "grep", "bash", "edit", "write"]) {
  const sent: SentMessage[] = [];
  const entries: Array<{ type: "custom"; customType: string; data: unknown }> = [];
  let activeTools = [...baseline];

  const pi = {
    getActiveTools: () => [...activeTools],
    setActiveTools: (names: string[]) => {
      activeTools = [...names];
    },
    sendMessage: (message: { content: string }) => {
      sent.push({ content: message.content, kind: "custom" });
    },
    sendUserMessage: (content: string) => {
      sent.push({ content: String(content), kind: "user" });
    },
    appendEntry: (customType: string, data: unknown) => {
      entries.push({ type: "custom", customType, data });
    },
  } as unknown as ExtensionAPI;

  return {
    pi,
    sent,
    entries,
    get activeTools() {
      return activeTools;
    },
  };
}

function fakeCtx(cwd: string, entries: unknown[] = []): ExtensionContext {
  return {
    cwd,
    hasUI: false,
    isIdle: () => true,
    sessionManager: { getBranch: () => entries },
  } as unknown as ExtensionContext;
}

function lines(count: number): string {
  return Array.from({ length: count }, (_, i) => `const x${i} = ${i};`).join("\n");
}

test("navigator mode keeps only allowlisted tools, and /pair off puts them back", async () => {
  const api = fakePi(["read", "grep", "bash", "edit", "write", "some_mcp_tool"]);
  const ctx = fakeCtx(root);
  const controller = makeController(api, ctx);

  await controller.start(ctx, "normal");
  assert.deepEqual(api.activeTools.toSorted(), ["bash", "grep", "interject", "pair_note", "read", "stay_quiet"]);
  // An unrecognised tool is refused rather than trusted, even though nothing
  // named it as a writer.
  assert.equal(api.activeTools.includes("some_mcp_tool"), false);

  await controller.stop(ctx);
  assert.deepEqual(api.activeTools.toSorted(), ["bash", "edit", "grep", "read", "some_mcp_tool", "write"]);
});

test("extraReadOnlyTools re-opens a tool without a restart", async () => {
  const api = fakePi(["read", "some_mcp_tool"]);
  const ctx = fakeCtx(root);
  const controller = makeController(api, ctx);

  await controller.start(ctx, "normal");
  assert.equal(api.activeTools.includes("some_mcp_tool"), false);

  controller.setOverrides({ extraReadOnlyTools: ["some_mcp_tool"] }, ctx);
  assert.equal(api.activeTools.includes("some_mcp_tool"), true);
});

test("an empty baseline is still restored on stop", async () => {
  const api = fakePi([]);
  const ctx = fakeCtx(root);
  const controller = makeController(api, ctx);

  await controller.start(ctx, "normal");
  assert.equal(api.activeTools.length > 0, true);
  await controller.stop(ctx);
  assert.deepEqual(api.activeTools, []);
});

test("cadence changes keep the driver's own settings", async () => {
  const api = fakePi();
  const ctx = fakeCtx(root);
  const controller = makeController(api, ctx);

  await controller.start(ctx, "normal");
  controller.setOverrides({ maxPatchLines: 40, strictBash: true }, ctx);
  controller.setCadence("quiet", ctx);

  assert.equal(controller.currentConfig.cadence, "quiet");
  assert.equal(controller.currentConfig.maxPatchLines, 40);
  assert.equal(controller.currentConfig.strictBash, true);
  // The preset itself still applies.
  assert.equal(controller.currentConfig.minChangedLines, 25);
});

test("a held-back file is not shown twice", async () => {
  const api = fakePi();
  const ctx = fakeCtx(root);
  const controller = makeController(api, ctx);
  const small = join(root, "small.ts");
  const big = join(root, "big.ts");

  await writeFile(small, "");
  await writeFile(big, "");
  await controller.start(ctx, "normal");

  // Below minChangedLines: held, not sent.
  await writeFile(small, "const a = 1;\nconst b = 2;\n");
  await controller.observeEdits([small], ctx);
  assert.equal(api.sent.length, 0);

  // Enough to trip the threshold; the held file rides along.
  await writeFile(big, lines(20));
  await controller.observeEdits([big], ctx);
  assert.equal(api.sent.length, 1);
  assert.match(api.sent[0]!.content, /small\.ts/);
  assert.match(api.sent[0]!.content, /const a = 1;/);

  // The navigator finishes its turn, then the driver touches the held file
  // again. Only the new line is news; the two it already saw are not.
  controller.noteAgentSettled(ctx);
  await writeFile(small, "const a = 1;\nconst b = 2;\nconst c = 3;\n");
  await writeFile(big, lines(40));
  await controller.observeEdits([small, big], ctx);

  assert.equal(api.sent.length, 2);
  assert.match(api.sent[1]!.content, /\+const c = 3;/);
  assert.equal(/\+const a = 1;/.test(api.sent[1]!.content), false);
});

test("a second burst waits rather than stacking on an unanswered one", async () => {
  const api = fakePi();
  const ctx = fakeCtx(root);
  const controller = makeController(api, ctx);
  const file = join(root, "a.ts");
  await writeFile(file, "");
  await controller.start(ctx, "chatty");

  await writeFile(file, lines(10));
  await controller.observeEdits([file], ctx);
  assert.equal(api.sent.length, 1);

  // The navigator has not answered yet, so this one is held.
  await writeFile(file, lines(30));
  await controller.observeEdits([file], ctx);
  assert.equal(api.sent.length, 1);

  // Once the turn settles it may look again, and the held edits are included.
  controller.noteAgentSettled(ctx);
  await controller.observeEdits([file], ctx);
  assert.equal(api.sent.length, 2);
});

test("an in-flight look does not block the driver asking directly", async () => {
  const api = fakePi();
  const ctx = fakeCtx(root);
  const controller = makeController(api, ctx);
  const file = join(root, "a.ts");
  await writeFile(file, "");
  await controller.start(ctx, "chatty");

  await writeFile(file, lines(10));
  await controller.observeEdits([file], ctx);
  assert.equal(api.sent.length, 1);

  const decision = await controller.lookNow(ctx, "what do you make of this?");
  assert.equal(decision.observe, true);
  assert.equal(api.sent.length, 2);
  assert.equal(api.sent[1]!.kind, "user");
  assert.match(api.sent[1]!.content, /what do you make of this\?/);
});

test("handing the keyboard back does not replay the agent's own work", async () => {
  const api = fakePi();
  const ctx = fakeCtx(root);
  const controller = makeController(api, ctx);
  const file = join(root, "a.ts");
  await writeFile(file, "");
  await controller.start(ctx, "chatty");

  controller.setRole("driver", ctx);
  // The agent writes while it has the keyboard. Nothing is shown...
  await writeFile(file, lines(50));
  await controller.observeEdits([file], ctx);
  assert.equal(api.sent.length, 0);

  // ...and on handback it is history, not news. Only what the driver types
  // afterwards counts.
  controller.setRole("navigator", ctx);
  await writeFile(file, `${lines(50)}\nconst mine = true;\n`);
  await controller.observeEdits([file], ctx);

  assert.equal(api.sent.length, 1);
  assert.match(api.sent[0]!.content, /\+const mine = true;/);
  assert.equal(/\+const x0 = 0;/.test(api.sent[0]!.content), false);
});

test("/pair look while muted still answers", async () => {
  const api = fakePi();
  const ctx = fakeCtx(root);
  const controller = makeController(api, ctx);
  await controller.start(ctx, "normal");
  controller.setMuted(true, ctx);

  const decision = await controller.lookNow(ctx);
  assert.equal(decision.observe, true);
  assert.equal(api.sent.length, 1);
});

test("a session that was pairing comes back pairing", async () => {
  const api = fakePi();
  const ctx = fakeCtx(root);
  const first = makeController(api, ctx);

  await first.start(ctx, "chatty");
  first.setOverrides({ minChangedLines: 42 }, ctx);
  first.setMuted(true, ctx);
  first.addNote({ kind: "decision", text: "retry at the transport layer", at: Date.now() }, ctx);

  // A fresh controller reading the same transcript.
  const replayed = fakeCtx(root, api.entries);

  const second = makeController(api, replayed);
  await second.restore(replayed);

  assert.equal(second.isActive, true);
  assert.equal(second.currentCadence, "chatty");
  assert.equal(second.currentConfig.minChangedLines, 42);
  assert.equal(second.isMuted, true);
  assert.equal(second.sessionNotes.length, 1);
});

test("a session that was not pairing comes back with its notes only", async () => {
  const api = fakePi();
  const ctx = fakeCtx(root);
  const first = makeController(api, ctx);

  await first.start(ctx, "normal");
  first.addNote({ kind: "risk", text: "no timeout on the outbound call", at: Date.now() }, ctx);
  await first.stop(ctx);

  const replayed = fakeCtx(root, api.entries);

  const second = makeController(api, replayed);
  await second.restore(replayed);
  assert.equal(second.isActive, false);
  assert.equal(second.sessionNotes.length, 1);
});
