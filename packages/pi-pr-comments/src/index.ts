import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { BorderedLoader } from "@earendil-works/pi-coding-agent";
import { showFeedbackBrowser } from "./browser.ts";
import { filterFeedback } from "./filter.ts";
import { formatBatchMessage, formatChatMessage, formatCompactSummary, formatStackMessage } from "./format.ts";
import { fetchFeedback, parsePrInput, resolvePullRequest, resolveRepository } from "./github.ts";
import { attachSnippets } from "./snippets.ts";
import { loadStackFeedback, type StackFeedback } from "./stack.ts";
import type { FeedbackItem, PullRequestInfo } from "./types.ts";

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

type FeedbackScope =
  | { kind: "single"; pr: PullRequestInfo; title: string; items: FeedbackItem[] }
  | ({ kind: "stack" } & StackFeedback);

async function loadFeedbackScope(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  args: string,
): Promise<FeedbackScope | undefined> {
  if (args.trim() === "--stack") {
    const stack = await withLoader(ctx, "Loading comments for the whole stack...", (signal) =>
      loadStackFeedback(pi, ctx.cwd, signal),
    );
    return stack ? { kind: "stack", ...stack } : undefined;
  }
  if (args.split(/\s+/).includes("--stack")) throw new Error("Use --stack alone to load the current checkout's stack");
  const pr = await findPullRequest(pi, ctx, args.trim());
  if (!pr) return undefined;
  const items = await withLoader(ctx, `Loading comments for PR #${pr.number}...`, async (signal) => {
    const feedback = await fetchFeedback(pi, ctx.cwd, pr, signal);
    return attachSnippets(pi, ctx.cwd, pr, feedback, signal);
  });
  return items ? { kind: "single", pr, title: `PR #${pr.number}: ${pr.title}`, items } : undefined;
}

async function runPrComments(
  pi: ExtensionAPI,
  args: string,
  ctx: ExtensionCommandContext,
  sendAll: boolean,
): Promise<void> {
  try {
    const scope = await loadFeedbackScope(pi, ctx, args);
    if (!scope) return;
    const { title, items } = scope;
    const batchMessage = (feedback: FeedbackItem[]) =>
      scope.kind === "stack"
        ? formatStackMessage(title, scope.layers, feedback, true)
        : formatBatchMessage(scope.pr, feedback);

    if (items.length === 0) {
      if (ctx.hasUI) ctx.ui.notify(`${title} has no comments`, "info");
      return;
    }

    if (ctx.mode !== "tui") {
      const summary = sendAll
        ? batchMessage(filterFeedback(items, "unresolved"))
        : scope.kind === "stack"
          ? formatStackMessage(title, scope.layers, items, false)
          : formatCompactSummary(scope.pr, items);
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
      : await showFeedbackBrowser(ctx, title, items);
    if (!selected) {
      if (sendAll) ctx.ui.notify(`${title} has no unresolved comments`, "info");
      return;
    }

    if (selected.mode === "unresolved") {
      const draft = batchMessage(selected.items);
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
    const pr = scope.kind === "single" ? scope.pr : selected.item.layer?.pr;
    if (!pr) throw new Error("Selected stack comment has no owning PR");
    sendMessage(pi, ctx, formatChatMessage(pr, selected.item, instructions));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (ctx.hasUI) ctx.ui.notify(`pr-comments: ${message}`, "error");
    else console.error(`pr-comments: ${message}`);
  }
}

export default function prCommentsExtension(pi: ExtensionAPI): void {
  pi.registerCommand("pr-comments", {
    description: "Browse PR comments (--stack for the whole gh stack)",
    handler: (args, ctx) => runPrComments(pi, args, ctx, false),
  });
  pi.registerCommand("pr-comments:all", {
    description: "Edit and send all unresolved PR comments (--stack for the whole gh stack)",
    handler: (args, ctx) => runPrComments(pi, args, ctx, true),
  });
}
