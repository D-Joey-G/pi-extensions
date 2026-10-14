import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import prCommentsExtension from "../src/index.ts";
import { formatChatMessage, formatPreview, formatStackMessage, itemLabel } from "../src/format.ts";
import { filterFeedback } from "../src/filter.ts";
import { loadStackFeedback } from "../src/stack.ts";

function github(stackCode = 0, failPr?: number): ExtensionAPI {
  return {
    exec: async (_command: string, args: string[]) => {
      let output: unknown;
      if (args[0] === "stack") {
        if (stackCode) return { code: stackCode, stdout: "", stderr: "not part of a stack" };
        output = {
          trunk: "main",
          branches: [
            { name: "merged", isMerged: true, pr: { number: 1, state: "MERGED" } },
            { name: "foundation", isMerged: false, pr: { number: 2, state: "OPEN" } },
            { name: "unsubmitted", isMerged: false },
            { name: "frontend", isMerged: false, pr: { number: 4, state: "QUEUED" } },
          ],
        };
      } else if (args[0] === "repo") {
        output = { nameWithOwner: "owner/repo" };
      } else if (args[0] === "pr") {
        const number = Number(args[2]);
        assert.ok(number === 2 || number === 4, "must skip merged and unsubmitted layers");
        assert.equal(args[4], "owner/repo");
        if (number === failPr) return { code: 1, stdout: "", stderr: "API unavailable" };
        output = {
          number,
          title: `Title ${number}`,
          url: `https://github.com/owner/repo/pull/${number}`,
          headRefOid: `head-${number}`,
          baseRefOid: `base-${number}`,
          headRefName: number === 2 ? "foundation" : "frontend",
          baseRefName: number === 2 ? "merged" : "unsubmitted",
        };
      } else if (args.includes("graphql")) {
        output = [{ data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } } }];
      } else if (args.some((arg) => arg.includes("contents/"))) {
        const ref = args.find((arg) => arg.startsWith("ref="))!.slice(4);
        return { code: 0, stdout: `source at ${ref}`, stderr: "" };
      } else if (args.at(-1)?.includes("/pulls/") && args.at(-1)?.endsWith("/comments")) {
        const number = args.at(-1)!.includes("/2/") ? 2 : 4;
        output = [
          [
            {
              id: 10,
              body: `Fix layer ${number}`,
              created_at: "2026-01-01",
              html_url: `https://github.com/comment-${number}`,
              user: { login: "reviewer" },
              path: "shared.ts",
              line: 1,
              side: "RIGHT",
              position: 1,
              commit_id: "old",
              original_commit_id: "old",
              diff_hunk: "fallback",
            },
          ],
        ];
      } else {
        output = [[]];
      }
      return { code: 0, stdout: JSON.stringify(output), stderr: "" };
    },
  } as unknown as ExtensionAPI;
}

test("whole-stack feedback preserves owning layers, unique selections, and per-PR source refs", async () => {
  const stack = await loadStackFeedback(github(), "/checkout");
  assert.deepEqual(
    stack.layers.map((layer) => layer.position),
    [2, 4],
  );
  assert.equal(new Set(stack.items.map((item) => item.id)).size, 2);
  assert.match(stack.items[0]!.snippet!.text, /source at head-2/);
  assert.match(stack.items[1]!.snippet!.text, /source at head-4/);
  assert.match(itemLabel(stack.items[0]!), /Layer 2\/4 · PR #2 · foundation/);
  assert.match(formatPreview(stack.items[1]!), /Layer 4\/4 · PR #4 · frontend/);
  const single = formatChatMessage(stack.layers[0]!.pr, stack.items[0]!, "");
  assert.match(single, /Apply changes on branch `foundation`/);
  const batch = formatStackMessage(stack.title, stack.layers, filterFeedback(stack.items, "unresolved"), true);
  assert.ok(batch.indexOf("# Layer 2/4") < batch.indexOf("# Layer 4/4"));
  assert.match(batch, /owning layer's branch/);
  assert.match(batch, /Fix layer 2/);
  assert.match(batch, /Fix layer 4/);
  const summary = formatStackMessage(stack.title, stack.layers, stack.items, false);
  assert.match(summary, /PR #2/);
  assert.match(summary, /PR #4/);
  const empty = formatStackMessage(stack.title, stack.layers, [], true);
  assert.match(empty, /No unresolved review threads/);
});

test("both commands expose whole-stack feedback outside the TUI", async () => {
  const pi = github();
  const commands = new Map<string, (args: string, ctx: ExtensionCommandContext) => Promise<void>>();
  const messages: string[] = [];
  pi.registerCommand = (name, options) => {
    commands.set(name, options.handler);
  };
  pi.sendMessage = (message) => {
    messages.push(String(message.content));
  };
  prCommentsExtension(pi);
  const ctx = { cwd: "/checkout", mode: "rpc", hasUI: false } as ExtensionCommandContext;
  await commands.get("pr-comments")!("--stack", ctx);
  assert.match(messages[0]!, /Layer 2\/4/);
  assert.match(messages[0]!, /Layer 4\/4/);
  await commands.get("pr-comments:all")!("--stack", ctx);
  assert.match(messages[1]!, /all unresolved pull request feedback across this stack/);
  assert.match(messages[1]!, /Fix layer 2/);
  assert.match(messages[1]!, /Fix layer 4/);
});

test("stack discovery and per-layer failures are explicit instead of returning partial feedback", async () => {
  await assert.rejects(loadStackFeedback(github(2), "/checkout"), /not part of a stack/);
  await assert.rejects(loadStackFeedback(github(0, 4), "/checkout"), /Layer 4 \(frontend, PR #4\): API unavailable/);
});
