import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type ControllerHooks, PairController, type ControllerSeams } from "../src/controller.js";
import { EditWatcher, type WatcherOptions } from "../src/watcher.js";

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
function makeController(
  api: ReturnType<typeof fakePi>,
  ctx: ExtensionContext,
  hooks: ControllerHooks = {},
  seams: ControllerSeams = {},
): PairController {
  const controller = new PairController(api.pi, hooks, seams);
  started.push({ controller, ctx });
  return controller;
}

/** A watcher that can be made to die the way chokidar does after startup. */
class ControllableWatcher extends EditWatcher {
  async fail(message: string): Promise<void> {
    // The real one tears itself down before reporting; a fake that does not
    // would leave this test holding an open chokidar instance.
    await this.stop();
    this.options.onError?.(new Error(message));
  }
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

/** A ctx with a UI attached, so what the driver actually sees can be asserted. */
function fakeUiCtx(cwd: string): { ctx: ExtensionContext; ui: { widget?: string[]; status?: string } } {
  const ui: { widget?: string[]; status?: string } = {};
  const ctx = {
    cwd,
    hasUI: true,
    isIdle: () => true,
    sessionManager: { getBranch: () => [] },
    ui: {
      setWidget: (_key: string, lines: string[] | undefined) => {
        ui.widget = lines;
      },
      setStatus: (_key: string, text: string | undefined) => {
        ui.status = text;
      },
    },
  } as unknown as ExtensionContext;
  return { ctx, ui };
}

/** Builds a custom transcript entry the way `appendEntry` records one. */
function entry(customType: string, data: unknown) {
  return { type: "custom", customType, data };
}

function lines(count: number): string {
  return Array.from({ length: count }, (_, i) => `const x${i} = ${i};`).join("\n");
}

test("navigator mode keeps only allowlisted tools, and /pair off puts them back", async () => {
  const api = fakePi(["read", "grep", "bash", "edit", "write", "some_mcp_tool"]);
  const ctx = fakeCtx(root);
  const controller = makeController(api, ctx);

  await controller.start(ctx, "normal");
  assert.deepEqual(api.activeTools.toSorted(), [
    "grep",
    "interject",
    "pair_note",
    "read",
    "request_drive",
    "stay_quiet",
  ]);
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
  controller.setOverrides({ maxPatchLines: 40 }, ctx);
  controller.setCadence("quiet", ctx);

  assert.equal(controller.currentConfig.cadence, "quiet");
  assert.equal(controller.currentConfig.maxPatchLines, 40);
  // The preset itself still applies.
  assert.equal(controller.currentConfig.minChangedLines, 25);
});

test("an approved scoped handoff restores navigator tools when the agent settles", async () => {
  const api = fakePi();
  const ctx = fakeCtx(root);
  const controller = makeController(api, ctx);

  await controller.start(ctx, "normal");
  controller.setRole("driver", ctx, { returnAfterSettled: true });
  assert.equal(controller.currentRole, "driver");
  assert.equal(api.activeTools.includes("edit"), true);

  assert.equal(controller.noteAgentSettled(ctx), true);
  assert.equal(controller.currentRole, "navigator");
  assert.equal(api.activeTools.includes("edit"), false);
  assert.equal(api.activeTools.includes("request_drive"), true);
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

test("an interrupted automatic handoff is not restored as standing permission", async () => {
  const api = fakePi();
  const ctx = fakeCtx(root);
  const first = makeController(api, ctx);

  await first.start(ctx, "normal");
  first.setRole("driver", ctx, { returnAfterSettled: true });

  const replayed = fakeCtx(root, api.entries);
  const second = makeController(api, replayed);
  await second.restore(replayed);

  assert.equal(second.currentRole, "navigator");
  assert.equal(api.activeTools.includes("edit"), false);
});

test("session cleanup preserves active state for reload and resume", async () => {
  const api = fakePi();
  const ctx = fakeCtx(root);
  const first = makeController(api, ctx);

  await first.start(ctx, "chatty");
  await first.dispose(ctx);

  const replayed = fakeCtx(root, api.entries);
  const second = makeController(api, replayed);
  await second.restore(replayed);
  assert.equal(second.isActive, true);
  assert.equal(second.currentCadence, "chatty");
});

test("a reverted held-back edit is not reported later", async () => {
  const api = fakePi();
  const ctx = fakeCtx(root);
  const controller = makeController(api, ctx);
  const small = join(root, "small.ts");
  const big = join(root, "big.ts");
  await writeFile(small, "original\n");
  await writeFile(big, "");
  await controller.start(ctx, "normal");

  await writeFile(small, "changed\n");
  await controller.observeEdits([small], ctx);
  await writeFile(small, "original\n");
  await controller.observeEdits([small], ctx);

  await writeFile(big, lines(20));
  await controller.observeEdits([big], ctx);
  assert.equal(api.sent.length, 1);
  assert.doesNotMatch(api.sent[0]!.content, /small\.ts/);
});

test("live config changes reach the watcher and snapshot", async () => {
  const api = fakePi();
  const ctx = fakeCtx(root);
  const controller = makeController(api, ctx);
  const file = join(root, "a.ts");
  await writeFile(file, "");
  await controller.start(ctx, "normal");
  await controller.setOverrides({ settleMs: 50, maxPatchLines: 8, minChangedLines: 1 }, ctx);

  await writeFile(file, lines(30));
  await new Promise((resolve) => setTimeout(resolve, 1200));
  assert.equal(api.sent.length, 1, "new settleMs should apply without restarting pair mode");
  assert.match(api.sent[0]!.content, /more diff lines truncated/);
});

test("a manual look drains pending watcher paths into one request", async () => {
  const api = fakePi();
  const ctx = fakeCtx(root);
  const controller = makeController(api, ctx);
  const file = join(root, "a.ts");
  await writeFile(file, "");
  await controller.start(ctx, "normal");

  await writeFile(file, lines(20));
  await new Promise((resolve) => setTimeout(resolve, 1000));
  await controller.lookNow(ctx, "anything concerning?");

  assert.equal(api.sent.length, 1);
  assert.equal(api.sent[0]!.kind, "user");
  assert.match(api.sent[0]!.content, /a\.ts/);
});

test("a dead watcher stops pairing rather than leaving a stale status", async () => {
  const api = fakePi();
  const { ctx, ui } = fakeUiCtx(root);
  let watcher: ControllableWatcher | undefined;
  let reported: Error | undefined;
  let onReported = (): void => {};
  // The hook fires only once teardown has finished, so everything asserted
  // below is the state the driver would see alongside the message.
  const reportedToDriver = new Promise<void>((resolve) => {
    onReported = resolve;
  });

  const controller = makeController(
    api,
    ctx,
    {
      onWatcherError: (error) => {
        reported = error;
        onReported();
      },
    },
    {
      openWatcher: (options: WatcherOptions) => {
        watcher = new ControllableWatcher(options);
        return watcher;
      },
    },
  );

  await controller.start(ctx, "normal");
  await watcher!.fail("too many open files");
  await reportedToDriver;

  assert.equal(reported?.message, "too many open files");
  assert.equal(controller.isActive, false);
  // The widget and footer must not still claim to be watching a tree nothing
  // is watching, and the driver's own tools have to come back.
  assert.equal(ui.status, undefined);
  assert.equal(ui.widget, undefined);
  assert.deepEqual(api.activeTools.toSorted(), ["bash", "edit", "grep", "read", "write"]);

  const decision = await controller.lookNow(ctx);
  assert.deepEqual(decision, { observe: false, reason: "pair mode is off" });
});

test("stopping drops held work and leaves nothing that can still speak", async () => {
  const api = fakePi();
  const { ctx, ui } = fakeUiCtx(root);
  const controller = makeController(api, ctx);
  const file = join(root, "a.ts");
  await writeFile(file, "");
  await controller.start(ctx, "normal");

  // Too small to send: this is now held for the next look.
  await writeFile(file, "const a = 1;\n");
  await controller.observeEdits([file], ctx);
  assert.match(ui.widget?.join("\n") ?? "", /holding/);

  await controller.stop(ctx);
  assert.equal(ui.widget, undefined);
  assert.equal(ui.status, undefined);

  // Whatever was held went with the runtime, and a burst that arrives after
  // the fact cannot resurrect it.
  await writeFile(file, lines(40));
  const decision = await controller.observeEdits([file], ctx);
  assert.deepEqual(decision, { observe: false, reason: "pair mode is off" });
  assert.equal(api.sent.length, 0);
});

test("a turn that dies without settling unblocks after the backstop", async () => {
  const api = fakePi();
  const ctx = fakeCtx(root);
  let clock = Date.parse("2026-01-01T00:00:00Z");
  const controller = makeController(api, ctx, {}, { now: () => clock });
  const file = join(root, "a.ts");
  await writeFile(file, "");
  await controller.start(ctx, "chatty");

  await writeFile(file, lines(10));
  await controller.observeEdits([file], ctx);
  assert.equal(api.sent.length, 1);

  // `agent_settled` never arrives, so the navigator stays marked as busy.
  await writeFile(file, lines(30));
  await controller.observeEdits([file], ctx);
  assert.equal(api.sent.length, 1);

  // Past the backstop, pairing resumes rather than staying stuck for the rest
  // of the session.
  clock += 6 * 60_000;
  await controller.observeEdits([file], ctx);
  assert.equal(api.sent.length, 2);
});

test("a corrupted session entry cannot arm a runaway navigator", async () => {
  const api = fakePi();
  // A transcript from another version: a cadence this one has never heard of,
  // and an override that is not a number.
  const ctx = fakeCtx(root, [
    entry("pair/note", { kind: "nonsense", text: "dropped" }),
    entry("pair/note", { kind: "risk", text: "kept", at: 1 }),
    entry("pair/state", {
      active: true,
      cadence: "breezy",
      role: "navigator",
      overrides: { minChangedLines: "lots", maxObservationsPerHour: 0 },
      baselineTools: ["read", 7, "grep"],
    }),
  ]);
  const controller = makeController(api, ctx);
  await controller.restore(ctx);

  assert.equal(controller.isActive, true);
  assert.equal(controller.currentCadence, "normal");
  // Unusable settings fall back to the preset instead of reaching the pacing
  // arithmetic, where every comparison against undefined reads as "go ahead".
  assert.equal(controller.currentConfig.minChangedLines, 8);
  assert.equal(controller.currentConfig.maxObservationsPerHour, 30);
  assert.deepEqual(
    controller.sessionNotes.map((note) => note.text),
    ["kept"],
  );

  const file = join(root, "a.ts");
  await writeFile(file, "const a = 1;\n");
  await controller.observeEdits([file], ctx);
  assert.equal(api.sent.length, 0, "a one-line edit must still be held back");
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
