import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Role } from "./types.js";

/**
 * Tools the navigator may call, as an allowlist rather than a denylist.
 *
 * The invariant is "the navigator cannot edit", and a denylist of known-bad
 * tool names cannot deliver that: any tool pi adds, any MCP server, any other
 * extension registering a writer would pass through unnamed. Inverting it means
 * an unrecognised tool is refused rather than trusted, which is the failure
 * mode we want. Shell access is deliberately absent: parsing arbitrary commands
 * cannot provide the same guarantee.
 *
 * The cost is that genuinely read-only MCP tools are blocked until the driver
 * names them; `extraReadOnlyTools` is the escape hatch, and the block message
 * says so.
 */
export const READ_ONLY_TOOLS = ["read", "grep", "ls", "find"];

/** Tools this extension registers. Only meaningful while pairing. */
export const PAIR_TOOLS = ["interject", "stay_quiet", "pair_note", "request_drive"];

/** True when the navigator is permitted to call this tool at all. */
export function isAllowedTool(name: string, extraReadOnlyTools: readonly string[]): boolean {
  return READ_ONLY_TOOLS.includes(name) || PAIR_TOOLS.includes(name) || extraReadOnlyTools.includes(name);
}

/**
 * Applies the tool set for a role, preserving whatever the driver had enabled.
 *
 * `baseline` is captured once at session start so that flipping to driver mode
 * and back restores the driver's own tool configuration rather than pi's
 * defaults.
 */
export function withoutPairTools(tools: readonly string[]): string[] {
  return tools.filter((name) => !PAIR_TOOLS.includes(name));
}

export function disablePairTools(pi: ExtensionAPI): void {
  pi.setActiveTools(withoutPairTools(pi.getActiveTools()));
}

export function applyRole(
  pi: ExtensionAPI,
  role: Role,
  baseline: string[],
  extraReadOnlyTools: readonly string[] = [],
): void {
  const cleanBaseline = withoutPairTools(baseline);
  if (role === "driver") {
    pi.setActiveTools([...new Set([...cleanBaseline, ...PAIR_TOOLS])]);
    return;
  }
  // Intersect rather than subtract: the navigator gets what is both enabled in
  // this session and known to be safe.
  const readOnly = cleanBaseline.filter((name) => isAllowedTool(name, extraReadOnlyTools));
  pi.setActiveTools([...new Set([...readOnly, ...PAIR_TOOLS])]);
}
