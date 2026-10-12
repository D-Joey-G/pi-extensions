import assert from "node:assert/strict";
import test from "node:test";
import { formatBatchMessage, formatChatMessage, formatCompactSummary, formatPreview } from "../src/format.ts";
import type { FeedbackItem, PullRequestInfo } from "../src/types.ts";

const pr: PullRequestInfo = {
  repo: "owner/repo",
  number: 7,
  title: "Improve parsing",
  url: "https://github.com/owner/repo/pull/7",
  headRefOid: "head",
  baseRefOid: "base",
  headRefName: "feature",
  baseRefName: "main",
};
const item: FeedbackItem = {
  id: "inline-2",
  kind: "inline",
  author: "reviewer",
  body: "Please rename this value.",
  createdAt: "2026-01-01T00:00:00Z",
  url: "https://github.com/owner/repo/pull/7#discussion_r2",
  path: "src/parser.ts",
  line: 20,
  startLine: 20,
  outdated: false,
  replies: [
    {
      id: 3,
      author: "author",
      body: "I can use parsedValue.",
      createdAt: "2026-01-02T00:00:00Z",
      url: "https://github.com/reply",
    },
  ],
  snippet: {
    path: "src/parser.ts",
    ref: "head",
    startLine: 20,
    endLine: 20,
    firstLine: 19,
    lastLine: 21,
    text: "  19 │ before\n> 20 │ const value = parse();\n  21 │ after",
    fallback: false,
  },
};

test("formatChatMessage includes thread, source, and user instructions", () => {
  const message = formatChatMessage(pr, item, "Keep the public API stable.");
  assert.match(message, /PR #7: Improve parsing/);
  assert.match(message, /Please rename this value/);
  assert.match(message, /Reply from @author/);
  assert.match(message, /src\/parser\.ts:20/);
  assert.match(message, /const value = parse/);
  assert.match(message, /Keep the public API stable/);
});

test("formatBatchMessage creates an editable message with each comment and snippet", () => {
  const second = {
    ...item,
    id: "inline-4",
    author: "second-reviewer",
    body: "Handle the empty case.",
    line: 40,
    snippet: {
      ...item.snippet!,
      startLine: 40,
      endLine: 40,
      firstLine: 40,
      lastLine: 40,
      text: "> 40 │ return empty;",
    },
  };
  const message = formatBatchMessage(pr, [item, second]);
  assert.match(
    message,
    /^Always begin by discussing with me; never comment on the PR or push anything to remote without asking first\./,
  );
  assert.match(message, /all unresolved pull request feedback/);
  assert.doesNotMatch(message, /github\.com/);
  assert.match(message, /## 1\. @reviewer/);
  assert.match(message, /## 2\. @second-reviewer/);
  assert.match(message, /### Reply from @author/);
  assert.match(message, /const value = parse/);
  assert.match(message, /return empty/);
});

test("preview and compact summary expose key feedback metadata", () => {
  assert.match(formatPreview(item), /Inline comment/);
  assert.match(formatPreview(item), /Open on GitHub/);
  const summary = formatCompactSummary(pr, [item]);
  assert.match(summary, /1 inline/);
  assert.match(summary, /reviewer/);
});
