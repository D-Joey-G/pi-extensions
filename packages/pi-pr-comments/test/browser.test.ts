import assert from "node:assert/strict";
import test from "node:test";
import { filterFeedback } from "../src/filter.ts";
import type { FeedbackItem } from "../src/types.ts";

function item(id: string, overrides: Partial<FeedbackItem> = {}): FeedbackItem {
  return {
    id,
    kind: "inline",
    author: "reviewer",
    body: "Feedback",
    createdAt: "2026-01-01T00:00:00Z",
    url: "https://github.com/comment",
    replies: [],
    ...overrides,
  };
}

test("filterFeedback filters inline threads by resolution", () => {
  const items = [
    item("unresolved", { resolved: false }),
    item("resolved", { resolved: true }),
    item("conversation", { kind: "conversation" }),
  ];
  assert.deepEqual(
    filterFeedback(items, "all").map(({ id }) => id),
    ["unresolved", "resolved", "conversation"],
  );
  assert.deepEqual(
    filterFeedback(items, "unresolved").map(({ id }) => id),
    ["unresolved"],
  );
  assert.deepEqual(
    filterFeedback(items, "resolved").map(({ id }) => id),
    ["resolved"],
  );
});
