import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Role } from "./types.js";

/**
 * Tools the navigator may call, as an allowlist rather than a denylist.
 *
 * The invariant is "the navigator cannot edit", and a denylist of known-bad
 * tool names cannot deliver that: any tool pi adds, any MCP server, any other
 * extension registering a writer would pass through unnamed. Inverting it means
 * an unrecognised tool is refused rather than trusted, which is the failure
 * mode we want. `bash` is here but screened separately by `isReadOnlyCommand`.
 *
 * The cost is that genuinely read-only MCP tools are blocked until the driver
 * names them; `extraReadOnlyTools` is the escape hatch, and the block message
 * says so.
 */
export const READ_ONLY_TOOLS = ["read", "grep", "ls", "find", "bash"];

/** Tools this extension registers. Only meaningful while navigating. */
export const PAIR_TOOLS = ["interject", "stay_quiet", "pair_note"];

/** True when the navigator is permitted to call this tool at all. */
export function isAllowedTool(name: string, extraReadOnlyTools: readonly string[]): boolean {
  return READ_ONLY_TOOLS.includes(name) || PAIR_TOOLS.includes(name) || extraReadOnlyTools.includes(name);
}

/**
 * Commands the navigator may run without asking. Anything that inspects the
 * repo, the history, or the test suite — nothing that writes to it.
 *
 * Matched against the first two words of each segment of a compound command,
 * which is a heuristic, not a sandbox. See `strictBash` for the real guarantee.
 */
export const READ_ONLY_COMMANDS = [
  "git log",
  "git diff",
  "git show",
  "git status",
  "git blame",
  "git branch",
  "git rev-parse",
  "git ls-files",
  "ls",
  "cat",
  "head",
  "tail",
  "wc",
  "find",
  "rg",
  "grep",
  "tree",
  "file",
  "stat",
  "which",
  "pwd",
  "echo",
  "jq",
  "npm test",
  "npm run",
  "npx tsc",
  "pnpm test",
  "yarn test",
  "pytest",
  "cargo check",
  "cargo test",
  "go test",
  "go vet",
  "make test",
];

/** Splits on shell operators so `cat x && rm -rf y` is screened as two commands. */
export function splitSegments(command: string): string[] {
  return command
    .split(/(?:&&|\|\||[;|\n])/g)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

/**
 * True when every segment of the command looks read-only.
 *
 * This is advisory. Redirections, subshells, and creative shell usage can slip
 * through, which is why a non-matching command asks the driver rather than
 * being silently rejected, and why `strictBash` exists for the paranoid case.
 */
export function isReadOnlyCommand(command: string): boolean {
  const segments = splitSegments(command);
  if (segments.length === 0) return false;
  return segments.every((segment) => {
    // Any redirection can write a file regardless of the verb in front of it.
    if (/(^|\s)>>?(\s|$)/.test(segment)) return false;
    if (/\$\(|`/.test(segment)) return false;
    const normalized = segment.replace(/\s+/g, " ").toLowerCase();
    return READ_ONLY_COMMANDS.some((allowed) => normalized === allowed || normalized.startsWith(`${allowed} `));
  });
}

/**
 * Applies the tool set for a role, preserving whatever the driver had enabled.
 *
 * `baseline` is captured once at session start so that flipping to driver mode
 * and back restores the driver's own tool configuration rather than pi's
 * defaults.
 */
export function applyRole(
  pi: ExtensionAPI,
  role: Role,
  baseline: string[],
  extraReadOnlyTools: readonly string[] = [],
): void {
  if (role === "driver") {
    pi.setActiveTools([...new Set([...baseline, ...PAIR_TOOLS])]);
    return;
  }
  // Intersect rather than subtract: the navigator gets what is both enabled in
  // this session and known to be safe.
  const readOnly = baseline.filter((name) => isAllowedTool(name, extraReadOnlyTools));
  pi.setActiveTools([...new Set([...readOnly, ...PAIR_TOOLS])]);
}
