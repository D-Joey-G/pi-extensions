import type { FeedbackItem } from "./types.ts";

export type FeedbackFilter = "all" | "unresolved" | "resolved";

export function filterFeedback(items: FeedbackItem[], filter: FeedbackFilter): FeedbackItem[] {
  if (filter === "all") return items;
  return items.filter(
    (item) => item.kind === "inline" && (filter === "resolved" ? item.resolved === true : item.resolved !== true),
  );
}
