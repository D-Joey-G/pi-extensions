export type FeedbackKind = "conversation" | "review" | "inline";

export interface PullRequestInfo {
  repo: string;
  number: number;
  title: string;
  url: string;
  headRefOid: string;
  baseRefOid: string;
  headRefName: string;
  baseRefName: string;
}

export interface FeedbackReply {
  id: number;
  author: string;
  body: string;
  createdAt: string;
  url: string;
}

export interface SourceSnippet {
  path: string;
  ref: string;
  startLine: number;
  endLine: number;
  firstLine: number;
  lastLine: number;
  text: string;
  fallback: boolean;
}

export interface StackLayer {
  pr: PullRequestInfo;
  position: number;
  total: number;
}

export interface FeedbackItem {
  layer?: StackLayer;
  id: string;
  kind: FeedbackKind;
  author: string;
  body: string;
  createdAt: string;
  url: string;
  state?: string;
  path?: string;
  line?: number;
  startLine?: number;
  originalLine?: number;
  originalStartLine?: number;
  side?: "LEFT" | "RIGHT";
  commitId?: string;
  originalCommitId?: string;
  outdated?: boolean;
  resolved?: boolean;
  diffHunk?: string;
  replies: FeedbackReply[];
  snippet?: SourceSnippet;
}

export interface IssueCommentPayload {
  id: number;
  body: string | null;
  created_at: string;
  html_url: string;
  user: { login: string } | null;
}

export interface ReviewPayload {
  id: number;
  body: string | null;
  state: string;
  submitted_at: string | null;
  html_url: string;
  user: { login: string } | null;
}

export interface ReviewThreadPayload {
  isResolved: boolean;
  comments: { nodes: Array<{ databaseId: number | null }> };
}

export interface ReviewThreadsResponse {
  data: {
    repository: {
      pullRequest: {
        reviewThreads: { nodes: ReviewThreadPayload[] };
      } | null;
    } | null;
  };
}

export interface ReviewCommentPayload {
  id: number;
  body: string | null;
  created_at: string;
  html_url: string;
  user: { login: string } | null;
  path: string;
  line: number | null;
  start_line: number | null;
  original_line: number | null;
  original_start_line: number | null;
  side: "LEFT" | "RIGHT" | null;
  position: number | null;
  original_position: number | null;
  commit_id: string;
  original_commit_id: string;
  diff_hunk: string;
  in_reply_to_id?: number;
}
