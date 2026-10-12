import type { FeedbackItem, PullRequestInfo } from "./types.ts";

const MAX_BODY_CHARS = 8_000;
const MAX_PREVIEW_BODY_CHARS = 1_500;
const MAX_COMPACT_ITEMS = 30;

function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 24)).trimEnd()}\n… (truncated)`;
}

function quote(text: string): string {
  return text
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

function kindLabel(item: FeedbackItem): string {
  if (item.kind === "inline") {
    const kind = item.outdated ? "Outdated inline comment" : "Inline comment";
    return item.resolved ? `Resolved ${kind.toLowerCase()}` : kind;
  }
  if (item.kind === "review") return item.state ? `Review: ${item.state.toLowerCase()}` : "Review summary";
  return "PR conversation";
}

export function locationLabel(item: FeedbackItem): string | undefined {
  if (!item.path) return undefined;
  const line = item.outdated ? item.originalLine : (item.line ?? item.originalLine);
  return line ? `${item.path}:${line}` : item.path;
}

export function itemLabel(item: FeedbackItem): string {
  const marker =
    item.kind === "inline" ? (item.resolved ? "✓" : item.outdated ? "○" : "●") : item.kind === "review" ? "◆" : "◇";
  const location = locationLabel(item);
  return `${marker} ${item.author}${location ? ` · ${location}` : ""}`;
}

export function itemDescription(item: FeedbackItem): string {
  const firstLine = item.body.replace(/\s+/g, " ").trim();
  return firstLine.length <= 120 ? firstLine : `${firstLine.slice(0, 119).trimEnd()}…`;
}

function threadMarkdown(item: FeedbackItem, bodyLimit = MAX_BODY_CHARS): string {
  const sections = [`**${item.author}**`, quote(truncate(item.body, bodyLimit))];
  for (const reply of item.replies) {
    sections.push(`**↳ ${reply.author}**`, quote(truncate(reply.body, bodyLimit)));
  }
  return sections.join("\n\n");
}

function sourceMarkdown(item: FeedbackItem): string | undefined {
  if (!item.path) return undefined;
  const location = locationLabel(item) ?? item.path;
  if (!item.snippet) return `### Source\n\n\`${location}\`\n\n_Source unavailable; use the GitHub link below._`;
  const fallback = item.snippet.fallback ? " (diff fallback)" : "";
  return `### Source${fallback}\n\n\`${location}\`\n\n\`\`\`text\n${item.snippet.text}\n\`\`\``;
}

export function formatPreview(item: FeedbackItem): string {
  const metadata = [kindLabel(item), locationLabel(item), item.outdated ? "outdated" : undefined]
    .filter(Boolean)
    .join(" · ");
  return [
    `### ${metadata}`,
    threadMarkdown(item, MAX_PREVIEW_BODY_CHARS),
    sourceMarkdown(item),
    `[Open on GitHub](${item.url})`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function formatChatMessage(pr: PullRequestInfo, item: FeedbackItem, additionalInstructions: string): string {
  const source = item.snippet
    ? [
        `Relevant source${item.snippet.fallback ? " (GitHub diff fallback)" : ""}:`,
        `\`${locationLabel(item) ?? item.snippet.path}\` at ref \`${item.snippet.ref}\``,
        "```text",
        item.snippet.text,
        "```",
      ].join("\n")
    : item.path
      ? `Relevant source: \`${locationLabel(item) ?? item.path}\` (snippet unavailable)`
      : undefined;

  return [
    "Help me address this pull request feedback.",
    `PR #${pr.number}: ${pr.title}`,
    pr.url,
    "",
    `${kindLabel(item)} from @${item.author}${locationLabel(item) ? ` on \`${locationLabel(item)}\`` : ""}:`,
    truncate(item.body, MAX_BODY_CHARS),
    ...item.replies.flatMap((reply) => ["", `Reply from @${reply.author}:`, truncate(reply.body, MAX_BODY_CHARS)]),
    "",
    source,
    additionalInstructions.trim() ? `\nAdditional instructions:\n${additionalInstructions.trim()}` : undefined,
  ]
    .filter((part): part is string => typeof part === "string")
    .join("\n");
}

export function formatBatchMessage(pr: PullRequestInfo, items: FeedbackItem[]): string {
  const sections = items.map((item, index) => {
    const location = locationLabel(item);
    const source = item.snippet
      ? [
          "### Relevant source",
          `\`${location ?? item.snippet.path}\` at ref \`${item.snippet.ref}\`${item.snippet.fallback ? " (GitHub diff fallback)" : ""}`,
          `\`\`\`text\n${item.snippet.text}\n\`\`\``,
        ].join("\n\n")
      : item.path
        ? `### Relevant source\n\n\`${location ?? item.path}\` (snippet unavailable)`
        : undefined;

    return [
      `## ${index + 1}. @${item.author}${location ? ` — \`${location}\`` : ""}`,
      "### Comment",
      truncate(item.body, MAX_BODY_CHARS),
      ...item.replies.flatMap((reply) => [`### Reply from @${reply.author}`, truncate(reply.body, MAX_BODY_CHARS)]),
      source,
    ]
      .filter((part): part is string => typeof part === "string")
      .join("\n\n");
  });

  return [
    "Always begin by discussing with me; never comment on the PR or push anything to remote without asking first.",
    "Help me address all unresolved pull request feedback below.",
    `# PR #${pr.number}: ${pr.title}`,
    ...sections,
  ]
    .join("\n\n")
    .trimEnd();
}

export function formatCompactSummary(pr: PullRequestInfo, items: FeedbackItem[]): string {
  const inline = items.filter((item) => item.kind === "inline").length;
  const outdated = items.filter((item) => item.kind === "inline" && item.outdated).length;
  const resolved = items.filter((item) => item.kind === "inline" && item.resolved).length;
  const reviews = items.filter((item) => item.kind === "review").length;
  const conversation = items.filter((item) => item.kind === "conversation").length;
  const lines = [
    `PR #${pr.number}: ${pr.title}`,
    pr.url,
    `${items.length} feedback item(s): ${inline} inline (${resolved} resolved, ${outdated} outdated), ${reviews} reviews, ${conversation} conversation comments`,
    "",
  ];
  for (const item of items.slice(0, MAX_COMPACT_ITEMS)) {
    lines.push(`- ${itemLabel(item)} — ${itemDescription(item)} (${item.url})`);
  }
  if (items.length > MAX_COMPACT_ITEMS) lines.push(`- … ${items.length - MAX_COMPACT_ITEMS} more`);
  return lines.join("\n");
}
