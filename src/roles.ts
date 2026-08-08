import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Role } from "./types.js";

/** Built-in tools that mutate the working tree. Never active in navigator mode. */
export const MUTATING_TOOLS = ["write", "edit", "multi_edit", "apply_patch", "str_replace_editor"];

/** Tools this extension registers. Only meaningful while navigating. */
export const PAIR_TOOLS = ["interject", "stay_quiet", "pair_note"];

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
export function applyRole(pi: ExtensionAPI, role: Role, baseline: string[]): void {
  if (role === "driver") {
    pi.setActiveTools([...new Set([...baseline, ...PAIR_TOOLS])]);
    return;
  }
  const readOnly = baseline.filter((name) => !MUTATING_TOOLS.includes(name));
  pi.setActiveTools([...new Set([...readOnly, ...PAIR_TOOLS])]);
}
