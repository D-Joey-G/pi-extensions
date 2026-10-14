import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fetchFeedback, resolvePullRequest, resolveRepository } from "./github.ts";
import { attachSnippets } from "./snippets.ts";
import type { FeedbackItem, StackLayer } from "./types.ts";

interface StackView {
  trunk: string;
  branches: Array<{
    name: string;
    isMerged: boolean;
    pr?: { number: number; state: "OPEN" | "MERGED" | "QUEUED" };
  }>;
}

export interface StackFeedback {
  title: string;
  layers: StackLayer[];
  items: FeedbackItem[];
}

export async function loadStackFeedback(pi: ExtensionAPI, cwd: string, signal?: AbortSignal): Promise<StackFeedback> {
  const result = await pi.exec("gh", ["stack", "view", "--json"], { cwd, signal, timeout: 30_000 });
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || "Could not read gh stack; install gh-stack and check out a stack branch");
  }
  let stack: StackView;
  try {
    stack = JSON.parse(result.stdout) as StackView;
    if (typeof stack.trunk !== "string" || !Array.isArray(stack.branches)) throw new Error();
  } catch {
    throw new Error("gh stack returned invalid stack JSON");
  }
  const repo = await resolveRepository(pi, cwd, signal);
  const layers: StackLayer[] = [];
  const items: FeedbackItem[] = [];
  for (const [index, branch] of stack.branches.entries()) {
    if (!branch.pr || branch.isMerged || branch.pr.state === "MERGED") continue;
    try {
      const pr = await resolvePullRequest(pi, cwd, repo, String(branch.pr.number), signal);
      const layer = { pr, position: index + 1, total: stack.branches.length };
      const feedback = await fetchFeedback(pi, cwd, pr, signal);
      const withSnippets = await attachSnippets(pi, cwd, pr, feedback, signal);
      layers.push(layer);
      items.push(...withSnippets.map((item) => ({ ...item, id: `${pr.number}:${item.id}`, layer })));
    } catch (error) {
      throw new Error(
        `Layer ${index + 1} (${branch.name}, PR #${branch.pr.number}): ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return {
    title: `Stack: ${[stack.trunk, ...stack.branches.map((branch) => branch.name)].join(" ← ")}`,
    layers,
    items,
  };
}
