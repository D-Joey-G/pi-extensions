import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fetchFileAtRef } from "./github.ts";
import type { FeedbackItem, PullRequestInfo, SourceSnippet } from "./types.ts";

interface SnippetTarget {
  path: string;
  ref: string;
  startLine: number;
  endLine: number;
}

export function selectSnippetTarget(item: FeedbackItem, pr: PullRequestInfo): SnippetTarget | undefined {
  if (item.kind !== "inline" || !item.path) return undefined;

  if (item.outdated) {
    const endLine = item.originalLine;
    if (!endLine) return undefined;
    return {
      path: item.path,
      ref: item.originalCommitId || item.commitId || pr.headRefOid,
      startLine: item.originalStartLine ?? endLine,
      endLine,
    };
  }

  const endLine = item.line ?? item.originalLine;
  if (!endLine) return undefined;
  return {
    path: item.path,
    ref: item.side === "LEFT" ? pr.baseRefOid : pr.headRefOid,
    startLine: item.startLine ?? endLine,
    endLine,
  };
}

export function extractSnippet(content: string, target: SnippetTarget, contextLines = 4): SourceSnippet | undefined {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  if (target.startLine < 1 || target.endLine < target.startLine || target.startLine > lines.length) {
    return undefined;
  }

  const firstLine = Math.max(1, target.startLine - contextLines);
  const lastLine = Math.min(lines.length, target.endLine + contextLines);
  const numberWidth = String(lastLine).length;
  const text = lines
    .slice(firstLine - 1, lastLine)
    .map((line, index) => {
      const lineNumber = firstLine + index;
      const marker = lineNumber >= target.startLine && lineNumber <= target.endLine ? ">" : " ";
      return `${marker} ${String(lineNumber).padStart(numberWidth)} │ ${line}`;
    })
    .join("\n");

  return {
    ...target,
    firstLine,
    lastLine,
    text,
    fallback: false,
  };
}

function diffFallback(item: FeedbackItem, target: SnippetTarget): SourceSnippet | undefined {
  if (!item.diffHunk?.trim()) return undefined;
  return {
    ...target,
    firstLine: target.startLine,
    lastLine: target.endLine,
    text: item.diffHunk.trim(),
    fallback: true,
  };
}

export async function attachSnippets(
  pi: ExtensionAPI,
  cwd: string,
  pr: PullRequestInfo,
  items: FeedbackItem[],
  signal?: AbortSignal,
): Promise<FeedbackItem[]> {
  const targets = new Map<string, SnippetTarget>();
  for (const item of items) {
    const target = selectSnippetTarget(item, pr);
    if (target) targets.set(`${target.ref}\0${target.path}`, target);
  }

  const files = new Map<string, string | undefined>();
  await Promise.all(
    [...targets.entries()].map(async ([key, target]) => {
      try {
        files.set(key, await fetchFileAtRef(pi, cwd, pr.repo, target.path, target.ref, signal));
      } catch {
        files.set(key, undefined);
      }
    }),
  );

  return items.map((item) => {
    const target = selectSnippetTarget(item, pr);
    if (!target) return item;
    const content = files.get(`${target.ref}\0${target.path}`);
    const snippet = content ? extractSnippet(content, target) : undefined;
    return { ...item, snippet: snippet ?? diffFallback(item, target) };
  });
}
