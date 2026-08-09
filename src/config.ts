import type { Cadence } from "./types.js";

export interface PairConfig {
  cadence: Cadence;
  /** Quiet period after the last file change before the burst counts as settled. */
  settleMs: number;
  /** Minimum gap between two unsolicited interjections. */
  minGapMs: number;
  /** Cap on observations sent to the model per rolling hour. Each one costs a request. */
  maxObservationsPerHour: number;
  /** Bursts smaller than this are folded into the next one instead of waking the model. */
  minChangedLines: number;
  /** Offer help after this long with no edits. 0 disables the nudge. */
  idleNudgeMs: number;
  /** Truncate each file's patch to this many lines before sending. */
  maxPatchLines: number;
  /** Read files up to this size; larger files are represented by metadata only. */
  maxFileBytes: number;
  /** Hard cap on files described in a single observation. */
  maxFilesPerObservation: number;
  /** Block every bash call outright instead of screening for read-only commands. */
  strictBash: boolean;
  /** Extra ignore globs on top of .gitignore and the built-in list. */
  ignore: string[];
  /**
   * Tool names the navigator may call on top of the built-in read-only set.
   *
   * Navigator mode is an allowlist, so MCP servers and other extensions'
   * tools are blocked until named here — see `READ_ONLY_TOOLS`.
   */
  extraReadOnlyTools: string[];
}

const CADENCE_PRESETS: Record<
  Cadence,
  Pick<PairConfig, "settleMs" | "minGapMs" | "maxObservationsPerHour" | "minChangedLines" | "idleNudgeMs">
> = {
  // Speaks only when something looks genuinely worth flagging.
  quiet: { settleMs: 20_000, minGapMs: 10 * 60_000, maxObservationsPerHour: 12, minChangedLines: 25, idleNudgeMs: 0 },
  // Roughly the rhythm of a human pair: a remark every few minutes of work.
  normal: {
    settleMs: 8_000,
    minGapMs: 3 * 60_000,
    maxObservationsPerHour: 30,
    minChangedLines: 8,
    idleNudgeMs: 12 * 60_000,
  },
  // Reacts to almost every meaningful edit. Useful when learning a codebase.
  chatty: {
    settleMs: 4_000,
    minGapMs: 45_000,
    maxObservationsPerHour: 90,
    minChangedLines: 3,
    idleNudgeMs: 5 * 60_000,
  },
};

export const DEFAULT_IGNORE = [
  "**/node_modules/**",
  "**/.git/**",
  "**/dist/**",
  "**/build/**",
  "**/out/**",
  "**/coverage/**",
  "**/.next/**",
  "**/target/**",
  "**/__pycache__/**",
  "**/*.log",
  "**/*.lock",
  "**/package-lock.json",
  "**/.DS_Store",
];

export function makeConfig(cadence: Cadence = "normal", overrides: Partial<PairConfig> = {}): PairConfig {
  return {
    cadence,
    ...CADENCE_PRESETS[cadence],
    maxPatchLines: 200,
    maxFileBytes: 2 * 1024 * 1024,
    maxFilesPerObservation: 12,
    strictBash: false,
    ignore: [],
    extraReadOnlyTools: [],
    ...overrides,
  };
}

export function isCadence(value: string): value is Cadence {
  return value === "quiet" || value === "normal" || value === "chatty";
}

/**
 * Everything `/pair set` accepts, and how to parse it.
 *
 * Cadence is deliberately absent: it has its own subcommands and setting it
 * replaces the whole preset block, which would make `/pair set` order-dependent.
 */
const NUMERIC_KEYS = [
  "settleMs",
  "minGapMs",
  "maxObservationsPerHour",
  "minChangedLines",
  "idleNudgeMs",
  "maxPatchLines",
  "maxFileBytes",
  "maxFilesPerObservation",
] as const satisfies ReadonlyArray<keyof PairConfig>;

const BOOLEAN_KEYS = ["strictBash"] as const satisfies ReadonlyArray<keyof PairConfig>;

const LIST_KEYS = ["ignore", "extraReadOnlyTools"] as const satisfies ReadonlyArray<keyof PairConfig>;

export const OVERRIDABLE_KEYS: readonly string[] = [...NUMERIC_KEYS, ...BOOLEAN_KEYS, ...LIST_KEYS];

export type ParsedOverride = { ok: true; override: Partial<PairConfig> } | { ok: false; error: string };

/** Parses one `key value` pair from `/pair set`. Values are validated, not trusted. */
export function parseOverride(key: string, raw: string): ParsedOverride {
  const value = raw.trim();
  if (!OVERRIDABLE_KEYS.includes(key)) {
    return { ok: false, error: `Unknown setting "${key}". Known: ${OVERRIDABLE_KEYS.join(", ")}.` };
  }
  if (value === "") return { ok: false, error: `Give a value: /pair set ${key} <value>` };

  if ((NUMERIC_KEYS as readonly string[]).includes(key)) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) return { ok: false, error: `${key} must be a number ≥ 0.` };
    if (!Number.isInteger(parsed)) return { ok: false, error: `${key} must be a whole number.` };
    // Only idleNudgeMs is meaningfully zero (it disables the nudge); a zero
    // budget or patch cap would silently switch the navigator off.
    if (parsed === 0 && key !== "idleNudgeMs") return { ok: false, error: `${key} must be greater than 0.` };
    return { ok: true, override: { [key]: parsed } };
  }

  if ((BOOLEAN_KEYS as readonly string[]).includes(key)) {
    if (value !== "true" && value !== "false") return { ok: false, error: `${key} must be true or false.` };
    return { ok: true, override: { [key]: value === "true" } };
  }

  const items = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return { ok: true, override: { [key]: items } };
}

/** Renders the current settings for `/pair config`. */
export function renderConfig(config: PairConfig): string {
  const lines = [`cadence  ${config.cadence}`];
  for (const key of OVERRIDABLE_KEYS) {
    const value = config[key as keyof PairConfig];
    lines.push(`${key.padEnd(23)}${Array.isArray(value) ? value.join(", ") || "—" : String(value)}`);
  }
  return lines.join("\n");
}
