import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { BorderedLoader } from "@earendil-works/pi-coding-agent";
import { showFeedbackBrowser } from "./browser.ts";
import { filterFeedback } from "./filter.ts";
import { formatBatchMessage, formatChatMessage, formatCompactSummary } from "./format.ts";
import { fetchFeedback, parsePrInput, resolvePullRequest, resolveRepository } from "./github.ts";
import { attachSnippets } from "./snippets.ts";
import type { PullRequestInfo } from "./types.ts";

type LoaderResult<T> = { status: "ok"; value: T } | { status: "error"; error: Error } | { status: "cancelled" };

function sendMessage(pi: ExtensionAPI, ctx: ExtensionCommandContext, message: string): void {
  if (ctx.isIdle()) {
    pi.sendUserMessage(message);
  } else {
    pi.sendUserMessage(message, { deliverAs: "followUp" });
    ctx.ui.notify("PR feedback queued as a follow-up", "info");
  }
}

async function withLoader<T>(
  ctx: ExtensionCommandContext,
  message: string,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T | undefined> {
  if (ctx.mode !== "tui") return operation(new AbortController().signal);

  const result = await ctx.ui.custom<LoaderResult<T>>((tui, theme, _keybindings, done) => {
    const loader = new BorderedLoader(tui, theme, message);
    let settled = false;
    const finish = (value: LoaderResult<T>) => {
      if (settled) return;
      settled = true;
      done(value);
    };
    loader.onAbort = () => finish({ status: "cancelled" });
    operation(loader.signal)
      .then((value) => finish({ status: "ok", value }))
      .catch((error: unknown) =>
        finish({ status: "error", error: error instanceof Error ? error : new Error(String(error)) }),
      );
    return loader;
  });

  if (result.status === "cancelled") return undefined;
  if (result.status === "error") throw result.error;
  return result.value;
}

async function findPullRequest(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  input: string,
): Promise<PullRequestInfo | undefined> {
  const parsed = input.trim() ? parsePrInput(input) : undefined;
  const repo =
    parsed?.repo ??
    (await withLoader(ctx, "Resolving GitHub repository...", (signal) => resolveRepository(pi, ctx.cwd, signal)));
  if (!repo) return undefined;

  try {
    return await withLoader(ctx, "Finding pull request...", (signal) =>
      resolvePullRequest(pi, ctx.cwd, repo, input || undefined, signal),
    );
  } catch (error) {
    if (input.trim() || !ctx.hasUI) throw error;
    const details = error instanceof Error ? error.message : String(error);
    const supplied = await ctx.ui.input(
      `No PR found for the active branch (${details}). Enter a PR number or URL:`,
      "123 or https://github.com/owner/repo/pull/123",
    );
    if (!supplied?.trim()) return undefined;
    return findPullRequest(pi, ctx, supplied);
  }
}

async function runPrComments(
  pi: ExtensionAPI,
  args: string,
  ctx: ExtensionCommandContext,
  sendAll: boolean,
): Promise<void> {
  try {
    const pr = await findPullRequest(pi, ctx, args.trim());
    if (!pr) return;

    const items = await withLoader(ctx, `Loading comments for PR #${pr.number}...`, async (signal) => {
      const feedback = await fetchFeedback(pi, ctx.cwd, pr, signal);
      return attachSnippets(pi, ctx.cwd, pr, feedback, signal);
    });
    if (!items) return;

    if (items.length === 0) {
      if (ctx.hasUI) ctx.ui.notify(`PR #${pr.number} has no comments`, "info");
      return;
    }

    if (ctx.mode !== "tui") {
      const summary = sendAll
        ? formatBatchMessage(pr, filterFeedback(items, "unresolved"))
        : formatCompactSummary(pr, items);
      if (ctx.mode === "print") {
        console.log(summary);
      } else {
        pi.sendMessage({
          customType: "pr-comments-summary",
          content: summary,
          display: true,
        });
      }
      return;
    }

    const unresolved = filterFeedback(items, "unresolved");
    const selected = sendAll
      ? unresolved.length > 0
        ? { mode: "unresolved" as const, items: unresolved }
        : undefined
      : await showFeedbackBrowser(ctx, pr, items);
    if (!selected) {
      if (sendAll) ctx.ui.notify(`PR #${pr.number} has no unresolved comments`, "info");
      return;
    }

    if (selected.mode === "unresolved") {
      const draft = formatBatchMessage(pr, selected.items);
      const message = await ctx.ui.editor(
        `Edit ${selected.items.length} unresolved PR comment(s) before sending`,
        draft,
      );
      if (!message?.trim()) return;
      sendMessage(pi, ctx, message);
      return;
    }

    const instructions = await ctx.ui.editor("Additional instructions (submit blank to use the comment as-is)", "");
    if (instructions === undefined) return;
    sendMessage(pi, ctx, formatChatMessage(pr, selected.item, instructions));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (ctx.hasUI) ctx.ui.notify(`pr-comments: ${message}`, "error");
    else console.error(`pr-comments: ${message}`);
  }
}

export default function prCommentsExtension(pi: ExtensionAPI): void {
  pi.registerCommand("pr-comments", {
    description: "Browse PR comments",
    handler: (args, ctx) => runPrComments(pi, args, ctx, false),
  });
  pi.registerCommand("pr-comments:all", {
    description: "Edit and send all unresolved PR comments",
    handler: (args, ctx) => runPrComments(pi, args, ctx, true),
  });
}
