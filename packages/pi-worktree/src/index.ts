import fs from "node:fs";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import type { UiAnswer, UiRequest } from "./agent.ts";
import { ensureWorktree, removeWorktree, slug } from "./git.ts";
import { registry, Tab } from "./tabs.ts";
import { TabsView } from "./view.ts";

const STATUS_KEY = "worktree";

function contextNote(dir: string, branch: string, origin: string): string {
  return [
    `You are working in a git worktree at ${dir}, on branch ${branch}.`,
    `It was created from ${origin}; earlier messages in this conversation happened there.`,
    `Read and change files only under ${dir}, not ${origin}.`,
  ].join("\n");
}

export default function (pi: ExtensionAPI) {
  const reg = registry();

  function updateStatus(): void {
    const ctx = reg.ctx;
    if (!ctx?.hasUI) return;
    if (!reg.tabs.length) return ctx.ui.setStatus(STATUS_KEY, undefined);
    const t = ctx.ui.theme;
    const parts = reg.tabs.map((tab, i) => `${t.fg("dim", `${i + 2}`)} ${tab.branch} ${tab.marker(t)}`);
    ctx.ui.setStatus(STATUS_KEY, `⎇ ${parts.join("  ")}`);
  }

  pi.on("session_start", (_event, ctx) => {
    reg.ctx = ctx;
    updateStatus();
  });

  pi.on("session_shutdown", (event) => {
    // The context dies with its session; agent callbacks must not reach it before the next session_start.
    reg.ctx = undefined;
    if (event.reason !== "quit") return;
    for (const tab of reg.tabs) void tab.agent.stop();
    reg.tabs = [];
  });

  /** The TUI instance is only handed to component factories; borrow it from an empty one. */
  async function tui(ctx: ExtensionContext): Promise<TUI> {
    if (!reg.tui) {
      await ctx.ui.custom<void>((tui, _theme, _keys, done) => {
        reg.tui = tui;
        done();
        return { render: () => [], invalidate() {} };
      });
    }
    return reg.tui!;
  }

  /**
   * Answers a child's dialog in the main UI. Dialogs queue so none hides another; the view
   * closes so they are visible, and reopens on its tab once the last one is answered.
   */
  function answer(tab: Tab, request: UiRequest): Promise<UiAnswer> {
    const dialogs = reg.dialogs;
    dialogs.pending++;
    if (reg.view) {
      dialogs.reopen = reg.view.tab;
      reg.view.select(undefined);
    }
    const result = dialogs.queue.then(() => ask(tab, request));
    dialogs.queue = result.catch(() => {});
    return result.finally(() => {
      if (--dialogs.pending > 0 || !dialogs.reopen) return;
      const reopen = dialogs.reopen;
      dialogs.reopen = undefined;
      if (reg.ctx && reg.tabs.includes(reopen)) void open(reg.ctx, reopen);
    });
  }

  async function ask(tab: Tab, request: UiRequest): Promise<UiAnswer> {
    const ctx = reg.ctx;
    if (!ctx?.hasUI) return { cancelled: true };
    const title = `[${tab.branch}] ${request.title}`;
    let result: UiAnswer;
    if (request.method === "confirm") result = { confirmed: await ctx.ui.confirm(title, request.message ?? "") };
    else {
      const value =
        request.method === "select"
          ? await ctx.ui.select(title, request.options ?? [])
          : request.method === "input"
            ? await ctx.ui.input(title, request.placeholder)
            : await ctx.ui.editor(title, request.prefill);
      result = value === undefined ? { cancelled: true } : { value };
    }
    return result;
  }

  function addTab(tab: Tab): void {
    reg.tabs.push(tab);
    tab.agent.onRecord((record) => {
      if (record.type === "agent_settled" && reg.view?.tab !== tab) {
        tab.unread = true;
        reg.ctx?.ui.notify(`⎇ ${tab.branch} finished`, "info");
      }
      if (record.type === "extension_ui_request" && record.method === "notify") {
        const level = record.notifyType === "warning" || record.notifyType === "error" ? record.notifyType : "info";
        reg.ctx?.ui.notify(`⎇ ${tab.branch}: ${String(record.message)}`, level);
      }
      // A closed tab's agent exits because it was asked to.
      if (record.type === "agent_exit" && reg.tabs.includes(tab))
        reg.ctx?.ui.notify(`⎇ ${tab.branch}: agent ${String(record.reason)}`, "error");
      for (const listener of reg.listeners) listener(tab, record);
      if (["agent_start", "agent_settled", "agent_exit"].includes(record.type)) updateStatus();
    });
    updateStatus();
  }

  function removeTab(tab: Tab): void {
    reg.tabs.splice(reg.tabs.indexOf(tab), 1);
    if (reg.lastTab === tab) reg.lastTab = undefined;
    if (reg.dialogs.reopen === tab) reg.dialogs.reopen = undefined;
    if (reg.view?.tab === tab) reg.view.select(reg.tabs[0]);
    updateStatus();
  }

  async function open(ctx: ExtensionContext, tab: Tab): Promise<void> {
    if (ctx.mode !== "tui") return;
    if (reg.view) return reg.view.select(tab);
    reg.lastTab = tab;
    await ctx.ui.custom<void>(
      (tui, theme, _keys, done) => {
        const opened = new TabsView(
          tui,
          theme,
          () => reg.tabs,
          tab,
          // Cleared before resolving, so a reopen right after closing builds a new view.
          () => {
            reg.lastTab = opened.tab ?? reg.lastTab;
            if (reg.view === opened) reg.view = undefined;
            updateStatus();
            done();
          },
          (listener) => {
            const wrapped = () => listener();
            reg.listeners.add(wrapped);
            return () => reg.listeners.delete(wrapped);
          },
          (shown) => {
            if (!shown.unread) return;
            shown.unread = false;
            updateStatus();
          },
        );
        reg.view = opened;
        return opened;
      },
      { overlay: true, overlayOptions: { width: "100%", maxHeight: "100%", row: 0, col: 0, margin: 0 } },
    );
  }

  function find(name: string): Tab | undefined {
    return reg.tabs.find((tab) => tab.branch === name || slug(tab.branch) === name);
  }

  async function create(ctx: ExtensionCommandContext, branch: string, prompt: string): Promise<void> {
    const existing = find(branch);
    if (existing && !existing.agent.dead) {
      if (prompt) await existing.agent.send(prompt);
      return open(ctx, existing);
    }
    if (existing) removeTab(existing);
    const worktree = await ensureWorktree(ctx.cwd, branch);
    // The worktree is a new path with no saved trust, and RPC mode cannot ask; it is the same repo,
    // so it inherits the main checkout's decision.
    const args = ["--name", `⎇ ${branch}`, ctx.isProjectTrusted() ? "--approve" : "--no-approve"];
    const sessionFile = ctx.sessionManager.getSessionFile();
    if (!worktree.created) {
      // Reopening: pick up the worktree's own latest session rather than forking again.
      args.push("--continue");
    } else {
      // pi writes the session file with the first reply; before that there is nothing to fork.
      if (sessionFile && fs.existsSync(sessionFile) && fs.statSync(sessionFile).size > 0)
        args.push("--fork", sessionFile);
      args.push("--append-system-prompt", contextNote(worktree.dir, branch, ctx.cwd));
      if (ctx.model) args.push("--model", `${ctx.model.provider}/${ctx.model.id}`, "--thinking", pi.getThinkingLevel());
    }
    const tab: Tab = new Tab(worktree, args, await tui(ctx), (request) => answer(tab, request));
    addTab(tab);
    ctx.ui.notify(`⎇ ${worktree.created ? "Created" : "Reopened"} ${worktree.dir}`, "info");
    tab.ready().then(
      () => {
        if (prompt) return tab.agent.send(prompt);
      },
      (error: unknown) => {
        // A dead agent has already reported its exit.
        if (!tab.agent.dead)
          reg.ctx?.ui.notify(`⎇ ${branch}: ${error instanceof Error ? error.message : String(error)}`, "error");
      },
    );
    await open(ctx, tab);
  }

  async function close(ctx: ExtensionCommandContext, name: string, remove: boolean): Promise<void> {
    const tab = find(name);
    if (!tab) return ctx.ui.notify(`No worktree tab named ${name}`, "warning");
    if (
      remove &&
      !(await ctx.ui.confirm(`Remove worktree ${tab.dir}?`, "The branch stays. Uncommitted changes block removal."))
    )
      return;
    removeTab(tab);
    const stopped = tab.agent.stop();
    if (!remove) return ctx.ui.notify(`⎇ Closed ${tab.branch}; the worktree stays at ${tab.dir}`, "info");
    try {
      // The agent may be mid-tool; let it exit before git deletes the directory under it.
      await stopped;
      await removeWorktree(tab.worktree);
      ctx.ui.notify(`⎇ Removed ${tab.dir}`, "info");
    } catch (error) {
      ctx.ui.notify(`⎇ ${error instanceof Error ? error.message : String(error)}`, "error");
    }
  }

  function completions(prefix: string): { value: string; label: string }[] | null {
    const words = prefix.split(/\s+/);
    const names = reg.tabs.map((tab) => tab.branch);
    if (words.length === 1) {
      return ["close", "remove", ...names]
        .filter((value) => value.startsWith(words[0]!))
        .map((value) => ({ value, label: value }));
    }
    if (words.length === 2 && (words[0] === "close" || words[0] === "remove")) {
      return names
        .filter((name) => name.startsWith(words[1]!))
        .map((name) => ({ value: `${words[0]} ${name}`, label: name }));
    }
    return null;
  }

  pi.registerCommand("worktree", {
    description: "Fork this session into a git worktree and open it in a tab: /worktree <branch> [prompt]",
    getArgumentCompletions: (prefix) => {
      const items = completions(prefix);
      // An exact match would make Enter apply the completion instead of running the command.
      return items?.some((item) => item.value === prefix.trim()) ? null : items;
    },
    handler: async (args, ctx) => {
      reg.ctx = ctx;
      if (ctx.mode !== "tui") return ctx.ui.notify("/worktree needs the interactive TUI", "error");
      const [first = "", ...rest] = args.trim().split(/\s+/).filter(Boolean);
      try {
        if ((first === "close" || first === "remove") && rest[0]) return await close(ctx, rest[0], first === "remove");
        if (first) return await create(ctx, first, args.trim().slice(first.length).trim());
        const tab = reg.lastTab ?? reg.tabs[0];
        if (tab) return await open(ctx, tab);
        const branch = (await ctx.ui.input("Worktree branch", "feature-name"))?.trim();
        if (branch) await create(ctx, branch, "");
      } catch (error) {
        ctx.ui.notify(`⎇ ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });

  pi.registerShortcut("alt+w", {
    description: "Open worktree tabs",
    handler: (ctx) => {
      const tab = reg.lastTab ?? reg.tabs[0];
      if (tab) void open(ctx, tab);
      else ctx.ui.notify("No worktree tabs. Start one with /worktree <branch>", "info");
    },
  });

  for (let n = 2; n <= 9; n++) {
    pi.registerShortcut(`alt+${n}` as "alt+2", {
      description: `Open worktree tab ${n}`,
      handler: (ctx) => {
        const tab = reg.tabs[n - 2];
        if (tab) void open(ctx, tab);
      },
    });
  }
}
