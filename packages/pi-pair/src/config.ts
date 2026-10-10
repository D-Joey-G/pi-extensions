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

const LIST_KEYS = ["ignore", "extraReadOnlyTools"] as const satisfies ReadonlyArray<keyof PairConfig>;

export const OVERRIDABLE_KEYS: readonly string[] = [...NUMERIC_KEYS, ...LIST_KEYS];

/**
 * Settings a zero is a real value for.
 *
 * Everywhere else zero would silently switch the navigator off — a zero budget
 * or patch cap looks like a setting and behaves like an uninstall.
 */
const ZERO_MEANS_OFF: readonly string[] = ["idleNudgeMs"];

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
    if (parsed === 0 && !ZERO_MEANS_OFF.includes(key)) return { ok: false, error: `${key} must be greater than 0.` };
    return { ok: true, override: { [key]: parsed } };
  }

  return { ok: true, override: { [key]: toStringList(value) } };
}

/** Splits a comma-separated `/pair set` value into its items. */
function toStringList(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

/** Keeps only the strings in an unknown value. Persisted lists are not trusted. */
export function toStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/**
 * Filters a persisted override bag down to values this version can use.
 *
 * A malformed override is dropped rather than repaired: without it the cadence
 * preset applies, which is always sane, whereas a `minChangedLines` of `"lots"`
 * would flow straight into the pacing arithmetic and compare as `false` against
 * everything — which the caller reads as "go ahead".
 */
export function sanitizeOverrides(value: unknown): Partial<PairConfig> {
  if (typeof value !== "object" || value === null) return {};
  const raw = value as Record<string, unknown>;
  const overrides: Partial<PairConfig> = {};
  for (const key of NUMERIC_KEYS) {
    const parsed = raw[key];
    if (typeof parsed !== "number" || !Number.isInteger(parsed) || parsed < 0) continue;
    if (parsed === 0 && !ZERO_MEANS_OFF.includes(key)) continue;
    overrides[key] = parsed;
  }
  for (const key of LIST_KEYS) {
    if (raw[key] !== undefined) overrides[key] = toStringArray(raw[key]);
  }
  return overrides;
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
