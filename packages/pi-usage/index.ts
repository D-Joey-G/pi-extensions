/**
 * Usage extension - remaining subscription quota for Claude, OpenAI (Codex) and OpenCode Go.
 *
 *   /usage            open the dashboard (r = refresh, esc/q = close)
 *   footer status     compact "remaining %" per provider, refreshed every 5 minutes
 *
 * Credentials are only ever read, never refreshed or written back:
 *   Claude       macOS keychain "Claude Code-credentials" (or ~/.claude/.credentials.json)
 *   OpenAI       ~/.codex/auth.json (ChatGPT login from the Codex CLI)
 *   OpenCode Go  ~/.pi/agent/auth.json "opencode-go" key, or $OPENCODE_API_KEY
 */

import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const exec = promisify(execFile);

// ───────────────────────────── data model ─────────────────────────────

interface Window {
  label: string;
  usedPct: number; // 0-100
  resetsAt?: Date;
  note?: string;
}

interface ProviderUsage {
  id: string;
  name: string;
  plan?: string;
  windows: Window[];
  error?: string;
  footer?: string; // short label used in the footer status
}

/** Enabled providers come from (first match wins):
 *  1. $PI_USAGE_PROVIDERS (comma-separated ids)
 *  2. ~/.pi/agent/pi-usage.json -> { "providers": ["claude", "openai", "opencode-go"] }
 *  3. default: all three
 */
const DEFAULT_PROVIDERS = ["claude", "openai", "opencode-go"];

function loadEnabledProviderIds(): Set<string> {
  const parse = (raw: string) =>
    new Set(
      raw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    );
  if (process.env.PI_USAGE_PROVIDERS) return parse(process.env.PI_USAGE_PROVIDERS);
  try {
    const cfg = JSON.parse(readFileSync(join(homedir(), ".pi", "agent", "pi-usage.json"), "utf8"));
    if (Array.isArray(cfg.providers) && cfg.providers.every((p: unknown) => typeof p === "string")) {
      return new Set(cfg.providers);
    }
  } catch {}
  return new Set(DEFAULT_PROVIDERS);
}

const ENABLED = loadEnabledProviderIds();

interface Provider {
  id: string;
  name: string;
  fetch(signal: AbortSignal): Promise<Omit<ProviderUsage, "id" | "name">>;
}

class SetupError extends Error {}

const clamp = (n: number) => Math.max(0, Math.min(100, n));

class RateLimitError extends Error {
  constructor(public retryAfterMs?: number) {
    super("rate limited");
  }
}

async function getJson(url: string, headers: Record<string, string>, signal: AbortSignal): Promise<any> {
  const res = await fetch(url, { headers, signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]) });
  if (res.status === 401 || res.status === 403) {
    const body = await res.text().catch(() => "");
    if (/expired/i.test(body)) throw new SetupError("login expired");
    throw new SetupError(`rejected (${res.status})`);
  }
  if (res.status === 429) {
    const ra = Number(res.headers.get("retry-after")) * 1000;
    throw new RateLimitError(Number.isFinite(ra) && ra > 0 ? ra : undefined);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// ───────────────────────────── providers ─────────────────────────────

async function readClaudeToken(): Promise<{ token: string; expiresAt?: number; tier?: string }> {
  let raw: string | undefined;
  if (process.platform === "darwin") {
    try {
      raw = (await exec("security", ["find-generic-password", "-s", "Claude Code-credentials", "-w"])).stdout;
    } catch {}
  }
  const file = join(homedir(), ".claude", ".credentials.json");
  if (!raw && existsSync(file)) raw = readFileSync(file, "utf8");
  if (!raw) throw new SetupError("no Claude Code login found");
  const oauth = JSON.parse(raw).claudeAiOauth;
  if (!oauth?.accessToken) throw new SetupError("no Claude Code login found");
  return { token: oauth.accessToken, expiresAt: oauth.expiresAt, tier: oauth.subscriptionType };
}

const claude: Provider = {
  id: "claude",
  name: "Claude",
  async fetch(signal) {
    const { token, expiresAt, tier } = await readClaudeToken();
    if (expiresAt && expiresAt < Date.now()) throw new SetupError("login expired - run `claude` once to refresh");
    // Anthropic rate-limits this endpoint by User-Agent; anything that does not
    // identify as Claude Code gets persistent 429s, so we send their UA string.
    const d = await getJson(
      "https://api.anthropic.com/api/oauth/usage",
      {
        Authorization: `Bearer ${token}`,
        "anthropic-beta": "oauth-2025-04-20",
        "User-Agent": "claude-code/2.1.0 (external, cli)",
      },
      signal,
    );
    const rows: [string, string][] = [
      ["five_hour", "5 hour"],
      ["seven_day", "Weekly"],
      ["seven_day_opus", "Weekly · Opus"],
      ["seven_day_sonnet", "Weekly · Sonnet"],
    ];
    const windows: Window[] = [];
    for (const [key, label] of rows) {
      const w = d[key];
      if (w && typeof w.utilization === "number") {
        windows.push({
          label,
          usedPct: clamp(w.utilization),
          resetsAt: w.resets_at ? new Date(w.resets_at) : undefined,
        });
      }
    }
    const extra = d.extra_usage;
    if (extra?.is_enabled) {
      windows.push({ label: "Extra credits", usedPct: clamp(extra.utilization ?? 0), note: extra.currency });
    }
    const plan = tier ? String(tier).replace(/^./, (c) => c.toUpperCase()) : undefined;
    return { plan, windows, footer: windows[0] ? `${Math.round(100 - windows[0].usedPct)}%` : undefined };
  },
};

const openai: Provider = {
  id: "openai",
  name: "OpenAI",
  async fetch(signal) {
    const file = join(homedir(), ".codex", "auth.json");
    if (!existsSync(file)) throw new SetupError("no Codex login - run `codex login`");
    const tokens = JSON.parse(readFileSync(file, "utf8")).tokens;
    if (!tokens?.access_token) throw new SetupError("no ChatGPT login in Codex - run `codex login`");
    const headers: Record<string, string> = {
      Authorization: `Bearer ${tokens.access_token}`,
      "User-Agent": "codex_cli_rs/0.1",
    };
    if (tokens.account_id) headers["chatgpt-account-id"] = tokens.account_id;
    let d: any;
    try {
      d = await getJson("https://chatgpt.com/backend-api/wham/usage", headers, signal);
    } catch (e) {
      if (e instanceof SetupError && /expired/.test(e.message)) {
        throw new SetupError("Codex login expired - run `codex` once to refresh");
      }
      throw e;
    }
    const windows: Window[] = [];
    const add = (prefix: string, w: any) => {
      if (!w || typeof w.used_percent !== "number") return;
      const secs = w.limit_window_seconds as number | undefined;
      const label = !secs
        ? "Limit"
        : secs <= 6 * 3600
          ? "5 hour"
          : secs <= 8 * 86400
            ? "Weekly"
            : `${Math.round(secs / 86400)} day`;
      const resetsAt = w.reset_at
        ? new Date(w.reset_at * 1000)
        : w.reset_after_seconds != null
          ? new Date(Date.now() + w.reset_after_seconds * 1000)
          : undefined;
      windows.push({ label: prefix + label, usedPct: clamp(w.used_percent), resetsAt });
    };
    add("", d.rate_limit?.primary_window);
    add("", d.rate_limit?.secondary_window);
    add("Code review · ", d.code_review_rate_limit?.primary_window);
    for (const extra of d.additional_rate_limits ?? []) {
      const prefix = extra.limit_name ? `${extra.limit_name} · ` : "";
      add(prefix, extra.rate_limit?.primary_window);
      add(prefix, extra.rate_limit?.secondary_window);
    }
    if (!windows.length) throw new Error("unrecognised usage response");
    return { plan: d.plan_type, windows, footer: `${Math.round(100 - windows[0].usedPct)}%` };
  },
};

const opencodeGo: Provider = {
  id: "opencode-go",
  name: "OpenCode Go",
  async fetch(signal) {
    let key = process.env.OPENCODE_API_KEY;
    if (!key) {
      try {
        key = JSON.parse(readFileSync(join(homedir(), ".pi", "agent", "auth.json"), "utf8"))["opencode-go"]?.key;
      } catch {}
    }
    if (!key) throw new SetupError("no OpenCode Go API key");
    const d = (await getJson("https://opencode.ai/zen/go/v1/usage", { Authorization: `Bearer ${key}` }, signal)).usage;
    const rows: [string, string][] = [
      ["rolling", "5 hour"],
      ["weekly", "Weekly"],
      ["monthly", "Monthly"],
    ];
    const windows: Window[] = [];
    for (const [k, label] of rows) {
      const w = d?.[k];
      if (!w) continue;
      windows.push({
        label,
        usedPct: clamp(w.percent ?? 0),
        // A 0-percent window carries a placeholder reset time, not a real one.
        resetsAt: w.percent ? (w.resetsAt ? new Date(w.resetsAt) : undefined) : undefined,
        note: w.status && w.status !== "ok" ? String(w.status) : undefined,
      });
    }
    if (!windows.length) throw new Error("unrecognised usage response");
    return { windows, footer: `${Math.round(100 - windows[0].usedPct)}%` };
  },
};

const PROVIDERS = [claude, openai, opencodeGo].filter((p) => ENABLED.has(p.id));

if (PROVIDERS.length === 0) {
  throw new Error(`pi-usage: no valid providers in config (valid ids: ${DEFAULT_PROVIDERS.join(", ")})`);
}

async function fetchProvider(p: Provider, signal: AbortSignal): Promise<ProviderUsage> {
  try {
    return { id: p.id, name: p.name, ...(await fetchWithCooldown(p, signal)) };
  } catch (e: any) {
    if (signal.aborted) return { id: p.id, name: p.name, windows: [], error: "cancelled" };
    const setup = e instanceof SetupError;
    return { id: p.id, name: p.name, windows: [], error: setup ? e.message : `failed: ${e?.message ?? e}` };
  }
}

/**
 * 429 handling: cool the provider down instead of retrying every tick.
 * Windows keep their last data; the overlay shows the cooling-off note.
 */
const COOLDOWN_MS = 10 * 60_000;
const coolUntil = new Map<string, number>();

async function fetchWithCooldown(p: Provider, signal: AbortSignal): Promise<Omit<ProviderUsage, "id" | "name">> {
  const until = coolUntil.get(p.id) ?? 0;
  if (until > Date.now()) {
    throw new SetupError(`cooling off for ${Math.ceil((until - Date.now()) / 60_000)} min after HTTP 429`);
  }
  try {
    return await p.fetch(signal);
  } catch (e) {
    if (e instanceof RateLimitError) {
      const wait = Math.max(e.retryAfterMs ?? 0, COOLDOWN_MS);
      coolUntil.set(p.id, Date.now() + wait);
    }
    throw e;
  }
}

// ───────────────────────────── rendering ─────────────────────────────

type Theme = { fg(color: any, text: string): string; bold(text: string): string };

function formatReset(d?: Date): string {
  if (!d) return "";
  const ms = d.getTime() - Date.now();
  if (ms <= 0) return "resets now";
  const mins = Math.round(ms / 60_000);
  const days = Math.floor(mins / 1440);
  const hours = Math.floor((mins % 1440) / 60);
  const m = mins % 60;
  if (days > 0) return `resets in ${days}d ${hours}h`;
  if (hours > 0) return `resets in ${hours}h ${String(m).padStart(2, "0")}m`;
  return `resets in ${m}m`;
}

function severity(remainingPct: number): "accent" | "warning" | "error" {
  return remainingPct <= 10 ? "error" : remainingPct <= 30 ? "warning" : "accent";
}

function bar(theme: Theme, remainingPct: number, width: number): string {
  const cells = Math.round((remainingPct / 100) * width);
  const filled = "━".repeat(cells);
  const empty = "━".repeat(width - cells);
  return theme.fg(severity(remainingPct), filled) + theme.fg("borderMuted", empty);
}

/** Map a pi model provider id (e.g. "claude-bridge", "openai-codex") to one of our providers. */
function activeProviderId(provider?: string): string | undefined {
  if (!provider) return undefined;
  if (/claude|anthropic/i.test(provider)) return "claude";
  if (/openai|codex/i.test(provider)) return "openai";
  if (/opencode/i.test(provider)) return "opencode-go";
  return undefined;
}

class UsageComponent {
  private results = new Map<string, ProviderUsage>();
  private loading = new Set<string>();
  private updatedAt?: Date;
  private abort?: AbortController;

  constructor(
    private tui: { requestRender(): void },
    private theme: Theme,
    private done: () => void,
    private load: (signal: AbortSignal, onResult: (u: ProviderUsage) => void) => Promise<void>,
    private seed: Map<string, ProviderUsage>,
  ) {
    for (const [k, v] of seed) this.results.set(k, v);
    void this.refresh();
  }

  async refresh() {
    this.abort?.abort();
    const abort = (this.abort = new AbortController());
    this.loading = new Set(PROVIDERS.map((p) => p.id));
    this.tui.requestRender();
    await this.load(abort.signal, (u) => {
      if (abort.signal.aborted) return;
      this.results.set(u.id, u);
      this.loading.delete(u.id);
      this.updatedAt = new Date();
      this.tui.requestRender();
    });
  }

  handleInput(data: string) {
    if (matchesKey(data, "escape") || data === "q" || matchesKey(data, "ctrl+c")) {
      this.abort?.abort();
      this.done();
    } else if (data === "r") {
      void this.refresh();
    }
  }

  invalidate() {}

  render(width: number): string[] {
    const t = this.theme;
    const inner = Math.max(30, Math.min(width, 68) - 4);
    const out: string[] = [];
    const row = (content = "") => {
      const pad = Math.max(0, inner - visibleWidth(content));
      out.push(t.fg("border", "│ ") + content + " ".repeat(pad) + t.fg("border", " │"));
    };
    const rule = (l: string, r: string, fill = "─") => out.push(t.fg("border", l + fill.repeat(inner + 2) + r));
    const split = (left: string, right: string) => {
      const gap = Math.max(1, inner - visibleWidth(left) - visibleWidth(right));
      return left + " ".repeat(gap) + right;
    };

    rule("╭", "╮");
    const spinning = this.loading.size > 0;
    row(
      split(
        t.bold(t.fg("accent", "Usage")),
        t.fg(
          "dim",
          spinning
            ? "refreshing…"
            : this.updatedAt
              ? `updated ${this.updatedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
              : "",
        ),
      ),
    );

    for (const p of PROVIDERS) {
      rule("├", "┤");
      const u = this.results.get(p.id);
      const plan = u?.plan ? t.fg("dim", ` ${u.plan}`) : "";
      row(t.bold(p.name) + plan);
      if (!u) {
        row(t.fg("dim", "  loading…"));
        continue;
      }
      if (u.error) {
        row(t.fg("warning", `  ${u.error}`));
        continue;
      }
      const labelW = Math.min(16, Math.max(...u.windows.map((w) => visibleWidth(w.label))));
      const barW = Math.max(8, inner - labelW - 8);
      for (const w of u.windows) {
        const remaining = 100 - w.usedPct;
        const pct = `${Math.round(remaining)}%`.padStart(4);
        const label = truncateToWidth(w.label, labelW).padEnd(labelW);
        row(`  ${t.fg("muted", label)} ${bar(t, remaining, barW)} ${t.fg(severity(remaining), pct)}`);
        const detail = [formatReset(w.resetsAt), w.note].filter(Boolean).join(" · ");
        if (detail) row(" ".repeat(labelW + 3) + t.fg("dim", truncateToWidth(detail, inner - labelW - 3)));
      }
    }

    rule("├", "┤");
    row(t.fg("dim", "remaining quota · r refresh · esc close"));
    rule("╰", "╯");
    return out.map((l) => truncateToWidth(l, width));
  }
}

// ───────────────────────────── extension ─────────────────────────────

export default function (pi: ExtensionAPI) {
  const STATUS_KEY = "usage";
  const REFRESH_MS = 5 * 60_000;
  const cache = new Map<string, ProviderUsage>();
  let timer: ReturnType<typeof setInterval> | undefined;
  let activeId: string | undefined;
  let themeTimer: ReturnType<typeof setInterval> | undefined;
  let statusCtx: { ui: { setStatus(key: string, text: string | undefined): void; theme: Theme } } | undefined;

  function renderStatus() {
    if (!statusCtx) return;
    const theme = statusCtx.ui.theme;
    const remainingOf = (u: ProviderUsage) => (u.windows[0] ? 100 - u.windows[0].usedPct : 100);
    const sep = theme.fg("dim", " · ");
    const parts: string[] = [];
    // Active provider first, with a thin bar; the rest as compact percentages.
    const ordered = [...PROVIDERS].sort((a, b) => Number(b.id === activeId) - Number(a.id === activeId));
    for (const p of ordered) {
      const u = cache.get(p.id);
      if (!u?.footer) continue;
      const remaining = remainingOf(u);
      if (p.id === activeId) {
        parts.push(
          theme.bold(theme.fg("accent", p.name)) +
            " " +
            bar(theme, remaining, 8) +
            " " +
            theme.fg(severity(remaining), u.footer),
        );
      } else {
        parts.push(theme.fg("dim", `${p.name.split(" ")[0]} `) + theme.fg(severity(remaining), u.footer));
      }
    }
    statusCtx.ui.setStatus(STATUS_KEY, parts.length ? parts.join(sep) : undefined);
  }

  async function loadAll(signal: AbortSignal, onResult: (u: ProviderUsage) => void) {
    await Promise.all(
      PROVIDERS.map(async (p) => {
        const u = await fetchProvider(p, signal);
        if (!signal.aborted) {
          cache.set(p.id, u);
          renderStatus();
        }
        onResult(u);
      }),
    );
  }

  pi.on("session_start", async (_event, ctx) => {
    statusCtx = ctx as any;
    activeId = activeProviderId(ctx.model?.provider);
    const tick = () => void loadAll(new AbortController().signal, () => {});
    const themeWatch = setInterval(renderStatus, 5_000);
    themeWatch.unref?.();
    themeTimer = themeWatch;
    tick();
    timer = setInterval(tick, REFRESH_MS);
    timer.unref?.();
  });

  // Footer text bakes in ANSI colours, so re-render from cache to follow theme switches.
  pi.on("turn_end", async () => renderStatus());

  pi.on("model_select", async (event) => {
    activeId = activeProviderId(event.model.provider);
    renderStatus();
  });

  pi.on("session_shutdown", async () => {
    if (timer) clearInterval(timer);
    timer = undefined;
    if (themeTimer) clearInterval(themeTimer);
    themeTimer = undefined;
    statusCtx = undefined;
  });

  pi.registerCommand("usage", {
    description: "Show remaining Claude / OpenAI / OpenCode Go usage",
    handler: async (_args, ctx) => {
      statusCtx = ctx as any;
      await ctx.ui.custom<void>(
        (tui, theme, _kb, done) => new UsageComponent(tui, theme as Theme, done, loadAll, new Map(cache)),
        { overlay: true },
      );
    },
  });
}
