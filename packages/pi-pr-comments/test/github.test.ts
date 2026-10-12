import assert from "node:assert/strict";
import test from "node:test";
import { normalizeFeedback, parsePrInput, reviewThreadResolutions } from "../src/github.ts";
import type { IssueCommentPayload, ReviewCommentPayload, ReviewPayload } from "../src/types.ts";

test("parsePrInput accepts numbers and GitHub PR URLs", () => {
  assert.deepEqual(parsePrInput("62"), { selector: "62" });
  assert.deepEqual(parsePrInput("https://github.com/perceptic/perceptic-plugins/pull/62"), {
    repo: "perceptic/perceptic-plugins",
    selector: "62",
  });
  assert.throws(() => parsePrInput("issue 62"), /PR number/);
  assert.throws(() => parsePrInput("https://example.com/a/b/pull/1"), /github.com/);
});

test("normalizeFeedback groups inline replies and retains outdated comments", () => {
  const conversation: IssueCommentPayload[] = [
    {
      id: 1,
      body: "General note",
      created_at: "2026-01-01T00:00:00Z",
      html_url: "https://github.com/c1",
      user: { login: "alice" },
    },
  ];
  const reviews: ReviewPayload[] = [
    {
      id: 2,
      body: "",
      state: "APPROVED",
      submitted_at: "2026-01-02T00:00:00Z",
      html_url: "https://github.com/r2",
      user: { login: "bob" },
    },
    {
      id: 3,
      body: "",
      state: "COMMENTED",
      submitted_at: "2026-01-02T01:00:00Z",
      html_url: "https://github.com/r3",
      user: { login: "bob" },
    },
  ];
  const root: ReviewCommentPayload = {
    id: 10,
    body: "Rename this",
    created_at: "2026-01-03T00:00:00Z",
    html_url: "https://github.com/i10",
    user: { login: "carol" },
    path: "src/a.ts",
    line: null,
    start_line: null,
    original_line: 12,
    original_start_line: null,
    side: "RIGHT",
    position: null,
    original_position: 4,
    commit_id: "head",
    original_commit_id: "old",
    diff_hunk: "@@ -8,5 +8,5 @@",
  };
  const reply: ReviewCommentPayload = {
    ...root,
    id: 11,
    body: "Agreed",
    created_at: "2026-01-04T00:00:00Z",
    html_url: "https://github.com/i11",
    user: { login: "dana" },
    in_reply_to_id: 10,
  };

  const items = normalizeFeedback(conversation, reviews, [root, reply], new Map([[10, true]]));
  assert.equal(items.length, 3);
  assert.equal(items[1]?.kind, "review");
  assert.equal(items[1]?.body, "Approved this pull request.");
  assert.equal(items[2]?.kind, "inline");
  assert.equal(items[2]?.outdated, true);
  assert.equal(items[2]?.resolved, true);
  assert.deepEqual(
    items[2]?.replies.map((item) => item.author),
    ["dana"],
  );
});

test("reviewThreadResolutions maps every comment in paginated threads", () => {
  const resolutions = reviewThreadResolutions([
    {
      data: {
        repository: {
          pullRequest: {
            reviewThreads: {
              nodes: [
                {
                  isResolved: true,
                  comments: { nodes: [{ databaseId: 10 }, { databaseId: 11 }] },
                },
              ],
            },
          },
        },
      },
    },
  ]);
  assert.equal(resolutions.get(10), true);
  assert.equal(resolutions.get(11), true);
});
