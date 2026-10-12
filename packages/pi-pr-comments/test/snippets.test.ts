import assert from "node:assert/strict";
import test from "node:test";
import { extractSnippet, selectSnippetTarget } from "../src/snippets.ts";
import type { FeedbackItem, PullRequestInfo } from "../src/types.ts";

const pr: PullRequestInfo = {
  repo: "owner/repo",
  number: 1,
  title: "Test",
  url: "https://github.com/owner/repo/pull/1",
  headRefOid: "head",
  baseRefOid: "base",
  headRefName: "feature",
  baseRefName: "main",
};

function inline(overrides: Partial<FeedbackItem> = {}): FeedbackItem {
  return {
    id: "inline-1",
    kind: "inline",
    author: "reviewer",
    body: "Feedback",
    createdAt: "2026-01-01T00:00:00Z",
    url: "https://github.com/comment",
    path: "src/a.ts",
    line: 5,
    startLine: 4,
    side: "RIGHT",
    commitId: "commit",
    originalCommitId: "original",
    replies: [],
    ...overrides,
  };
}

test("selectSnippetTarget chooses head, base, or original revisions", () => {
  assert.deepEqual(selectSnippetTarget(inline(), pr), {
    path: "src/a.ts",
    ref: "head",
    startLine: 4,
    endLine: 5,
  });
  assert.equal(selectSnippetTarget(inline({ side: "LEFT" }), pr)?.ref, "base");
  assert.deepEqual(
    selectSnippetTarget(
      inline({ outdated: true, line: undefined, startLine: undefined, originalLine: 9, originalStartLine: 8 }),
      pr,
    ),
    { path: "src/a.ts", ref: "original", startLine: 8, endLine: 9 },
  );
});

test("extractSnippet marks target lines and includes bounded context", () => {
  const content = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join("\n");
  const snippet = extractSnippet(content, { path: "src/a.ts", ref: "head", startLine: 5, endLine: 6 }, 2);
  assert.equal(snippet?.firstLine, 3);
  assert.equal(snippet?.lastLine, 8);
  assert.match(snippet?.text ?? "", /> 5 │ line 5/);
  assert.match(snippet?.text ?? "", /  8 │ line 8/);
});
