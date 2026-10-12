import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type {
  FeedbackItem,
  FeedbackReply,
  IssueCommentPayload,
  PullRequestInfo,
  ReviewCommentPayload,
  ReviewPayload,
  ReviewThreadsResponse,
} from "./types.ts";

const GH_TIMEOUT_MS = 30_000;
const REVIEW_THREADS_QUERY = `
query($owner: String!, $name: String!, $number: Int!, $endCursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $endCursor) {
        nodes {
          isResolved
          comments(first: 100) { nodes { databaseId } }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}`;

interface ExecOptions {
  cwd: string;
  signal?: AbortSignal;
}

interface ParsedPrInput {
  repo?: string;
  selector: string;
}

function commandError(stderr: string, fallback: string): Error {
  return new Error(stderr.trim() || fallback);
}

async function runGh(pi: ExtensionAPI, args: string[], options: ExecOptions): Promise<string> {
  const result = await pi.exec("gh", args, {
    cwd: options.cwd,
    signal: options.signal,
    timeout: GH_TIMEOUT_MS,
  });
  if (result.code !== 0) {
    throw commandError(result.stderr, `gh exited with code ${result.code}`);
  }
  return result.stdout;
}

async function runGhJson<T>(pi: ExtensionAPI, args: string[], options: ExecOptions): Promise<T> {
  const output = await runGh(pi, args, options);
  try {
    return JSON.parse(output) as T;
  } catch {
    throw new Error("GitHub returned invalid JSON");
  }
}

async function fetchPages<T>(pi: ExtensionAPI, repo: string, endpoint: string, options: ExecOptions): Promise<T[]> {
  const pages = await runGhJson<T[][]>(pi, ["api", "--paginate", "--slurp", `repos/${repo}/${endpoint}`], options);
  return pages.flat();
}

export function parsePrInput(input: string): ParsedPrInput {
  const value = input.trim();
  if (/^\d+$/.test(value)) {
    return { selector: value };
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Expected a PR number or GitHub pull request URL");
  }

  const match = url.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/);
  if (url.hostname !== "github.com" || !match) {
    throw new Error("Expected a github.com pull request URL");
  }
  return { repo: `${match[1]}/${match[2]}`, selector: match[3] };
}

export async function resolveRepository(pi: ExtensionAPI, cwd: string, signal?: AbortSignal): Promise<string> {
  const result = await runGhJson<{ nameWithOwner: string }>(pi, ["repo", "view", "--json", "nameWithOwner"], {
    cwd,
    signal,
  });
  if (!result.nameWithOwner) {
    throw new Error("Could not resolve a GitHub repository from this checkout");
  }
  return result.nameWithOwner;
}

export async function resolvePullRequest(
  pi: ExtensionAPI,
  cwd: string,
  repo: string,
  input?: string,
  signal?: AbortSignal,
): Promise<PullRequestInfo> {
  let targetRepo = repo;
  const args = ["pr", "view"];
  if (input?.trim()) {
    const parsed = parsePrInput(input);
    targetRepo = parsed.repo ?? repo;
    args.push(parsed.selector, "--repo", targetRepo);
  }
  args.push("--json", "number,title,url,headRefOid,baseRefOid,headRefName,baseRefName");

  const pr = await runGhJson<Omit<PullRequestInfo, "repo">>(pi, args, { cwd, signal });
  return { repo: targetRepo, ...pr };
}

function author(login: string | undefined): string {
  return login || "ghost";
}

function reviewBody(review: ReviewPayload): string | undefined {
  const body = review.body?.trim();
  if (body) return body;
  if (review.state === "APPROVED") return "Approved this pull request.";
  if (review.state === "CHANGES_REQUESTED") return "Requested changes on this pull request.";
  return undefined;
}

export function normalizeFeedback(
  conversation: IssueCommentPayload[],
  reviews: ReviewPayload[],
  inlineComments: ReviewCommentPayload[],
  threadResolutions = new Map<number, boolean>(),
): FeedbackItem[] {
  const items: FeedbackItem[] = conversation.map((comment) => ({
    id: `conversation-${comment.id}`,
    kind: "conversation",
    author: author(comment.user?.login),
    body: comment.body?.trim() || "(No comment body)",
    createdAt: comment.created_at,
    url: comment.html_url,
    replies: [],
  }));

  for (const review of reviews) {
    const body = reviewBody(review);
    if (!body || !review.submitted_at) continue;
    items.push({
      id: `review-${review.id}`,
      kind: "review",
      author: author(review.user?.login),
      body,
      createdAt: review.submitted_at,
      url: review.html_url,
      state: review.state,
      replies: [],
    });
  }

  const byId = new Map(inlineComments.map((comment) => [comment.id, comment]));
  const repliesByRoot = new Map<number, FeedbackReply[]>();
  for (const comment of inlineComments) {
    if (!comment.in_reply_to_id) continue;
    let rootId = comment.in_reply_to_id;
    while (byId.get(rootId)?.in_reply_to_id) {
      rootId = byId.get(rootId)!.in_reply_to_id!;
    }
    const replies = repliesByRoot.get(rootId) ?? [];
    replies.push({
      id: comment.id,
      author: author(comment.user?.login),
      body: comment.body?.trim() || "(No comment body)",
      createdAt: comment.created_at,
      url: comment.html_url,
    });
    repliesByRoot.set(rootId, replies);
  }

  for (const comment of inlineComments) {
    if (comment.in_reply_to_id) continue;
    items.push({
      id: `inline-${comment.id}`,
      kind: "inline",
      author: author(comment.user?.login),
      body: comment.body?.trim() || "(No comment body)",
      createdAt: comment.created_at,
      url: comment.html_url,
      path: comment.path,
      line: comment.line ?? undefined,
      startLine: comment.start_line ?? undefined,
      originalLine: comment.original_line ?? undefined,
      originalStartLine: comment.original_start_line ?? undefined,
      side: comment.side ?? undefined,
      commitId: comment.commit_id,
      originalCommitId: comment.original_commit_id,
      outdated: comment.position === null,
      resolved: threadResolutions.get(comment.id),
      diffHunk: comment.diff_hunk,
      replies: (repliesByRoot.get(comment.id) ?? []).sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    });
  }

  return items.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function reviewThreadResolutions(responses: ReviewThreadsResponse[]): Map<number, boolean> {
  const resolutions = new Map<number, boolean>();
  for (const response of responses) {
    const threads = response.data.repository?.pullRequest?.reviewThreads.nodes ?? [];
    for (const thread of threads) {
      for (const comment of thread.comments.nodes) {
        if (comment.databaseId !== null) resolutions.set(comment.databaseId, thread.isResolved);
      }
    }
  }
  return resolutions;
}

async function fetchReviewThreadResolutions(
  pi: ExtensionAPI,
  cwd: string,
  pr: PullRequestInfo,
  signal?: AbortSignal,
): Promise<Map<number, boolean>> {
  const [owner, name] = pr.repo.split("/");
  if (!owner || !name) throw new Error(`Invalid GitHub repository: ${pr.repo}`);
  const responses = await runGhJson<ReviewThreadsResponse[]>(
    pi,
    [
      "api",
      "graphql",
      "--paginate",
      "--slurp",
      "-f",
      `query=${REVIEW_THREADS_QUERY}`,
      "-F",
      `owner=${owner}`,
      "-F",
      `name=${name}`,
      "-F",
      `number=${pr.number}`,
    ],
    { cwd, signal },
  );
  return reviewThreadResolutions(responses);
}

export async function fetchFeedback(
  pi: ExtensionAPI,
  cwd: string,
  pr: PullRequestInfo,
  signal?: AbortSignal,
): Promise<FeedbackItem[]> {
  const options = { cwd, signal };
  const [conversation, reviews, inlineComments, threadResolutions] = await Promise.all([
    fetchPages<IssueCommentPayload>(pi, pr.repo, `issues/${pr.number}/comments`, options),
    fetchPages<ReviewPayload>(pi, pr.repo, `pulls/${pr.number}/reviews`, options),
    fetchPages<ReviewCommentPayload>(pi, pr.repo, `pulls/${pr.number}/comments`, options),
    fetchReviewThreadResolutions(pi, cwd, pr, signal),
  ]);
  return normalizeFeedback(conversation, reviews, inlineComments, threadResolutions);
}

export async function fetchFileAtRef(
  pi: ExtensionAPI,
  cwd: string,
  repo: string,
  path: string,
  ref: string,
  signal?: AbortSignal,
): Promise<string> {
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  return runGh(
    pi,
    [
      "api",
      "--method",
      "GET",
      `repos/${repo}/contents/${encodedPath}`,
      "-H",
      "Accept: application/vnd.github.raw+json",
      "-f",
      `ref=${ref}`,
    ],
    { cwd, signal },
  );
}
