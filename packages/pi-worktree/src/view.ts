import { getSelectListTheme, type Theme } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  Editor,
  type Focusable,
  Key,
  matchesKey,
  truncateToWidth,
  type TUI,
  type TuiMouseEvent,
  type TuiMouseEventResult,
  visibleWidth,
} from "@earendil-works/pi-tui";
import type { Tab } from "./tabs.ts";

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function fit(line: string, width: number): string {
  const clipped = truncateToWidth(line, width, "");
  return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

function home(dir: string): string {
  const user = process.env.HOME;
  return user && dir.startsWith(user) ? `~${dir.slice(user.length)}` : dir;
}

/**
 * Full-screen tab strip over the main chat: one worktree agent's transcript and its own editor.
 * Choosing the main tab closes the view; the main session keeps running underneath throughout.
 */
export class TabsView implements Component, Focusable {
  private index: number;
  private readonly editors = new Map<Tab, Editor>();
  private readonly unsubscribe: () => void;
  private readonly timer: ReturnType<typeof setInterval>;
  private frame = 0;
  private focusedState = true;
  private error: string | undefined;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly tabs: () => Tab[],
    start: Tab,
    private readonly done: () => void,
    subscribe: (listener: () => void) => () => void,
    /** Called whenever a tab comes into view. */
    private readonly onShow: (tab: Tab) => void,
  ) {
    this.index = Math.max(0, tabs().indexOf(start));
    if (this.tab) onShow(this.tab);
    this.unsubscribe = subscribe(() => this.tui.requestRender());
    this.timer = setInterval(() => {
      if (this.tab?.agent.running) {
        this.frame++;
        this.tui.requestRender();
      }
    }, 100);
    this.timer.unref?.();
    this.syncFocus();
  }

  get tab(): Tab | undefined {
    return this.tabs()[this.index];
  }

  get focused(): boolean {
    return this.focusedState;
  }

  set focused(value: boolean) {
    this.focusedState = value;
    this.syncFocus();
  }

  /** Shows `tab`, or closes the view when it is no longer open. */
  select(tab: Tab | undefined): void {
    const index = tab ? this.tabs().indexOf(tab) : -1;
    if (index < 0) return this.done();
    this.index = index;
    this.error = undefined;
    this.onShow(tab!);
    this.syncFocus();
    this.tui.requestRender();
  }

  private syncFocus(): void {
    for (const [tab, editor] of this.editors) editor.focused = this.focusedState && tab === this.tab;
  }

  private editor(tab: Tab): Editor {
    let editor = this.editors.get(tab);
    if (!editor) {
      editor = new Editor(this.tui, {
        borderColor: (text) => this.theme.fg("border", text),
        selectList: getSelectListTheme(),
      });
      editor.onSubmit = (text) => void this.submit(tab, editor!, text);
      this.editors.set(tab, editor);
      this.syncFocus();
    }
    return editor;
  }

  private async submit(tab: Tab, editor: Editor, text: string): Promise<void> {
    const message = text.trim();
    if (!message) return;
    editor.addToHistory?.(message);
    editor.setText("");
    tab.follow();
    try {
      await tab.agent.send(message);
      this.error = undefined;
    } catch (error) {
      editor.setText(text);
      this.error = error instanceof Error ? error.message : String(error);
    }
    this.tui.requestRender();
  }

  handleInput(data: string): void {
    const tab = this.tab;
    if (!tab) return this.done();
    const tabs = this.tabs();
    if (matchesKey(data, Key.alt("1"))) return this.done();
    for (let n = 2; n <= 9; n++) {
      if (matchesKey(data, Key.alt(String(n) as "2"))) {
        if (tabs[n - 2]) this.select(tabs[n - 2]);
        return;
      }
    }
    if (matchesKey(data, Key.alt("w"))) return this.select(tabs[this.index + 1]);
    if (matchesKey(data, Key.ctrl("o"))) {
      tab.transcript.setExpanded(!tab.transcript.toolsExpanded);
      return this.tui.requestRender();
    }
    if (matchesKey(data, Key.pageUp)) return this.scroll(tab, this.bodyHeight());
    if (matchesKey(data, Key.pageDown)) return this.scroll(tab, -this.bodyHeight());
    if (matchesKey(data, Key.escape)) {
      if (tab.agent.running) void tab.agent.abort().catch(() => {});
      else this.done();
      return;
    }
    const editor = this.editor(tab);
    if (matchesKey(data, Key.ctrl("c"))) {
      if (editor.getText()) editor.setText("");
      else this.done();
      return this.tui.requestRender();
    }
    editor.handleInput(data);
    this.tui.requestRender();
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    const tab = this.tab;
    if (!tab || event.type !== "wheel") return undefined;
    const lines = Math.trunc(event.wheelDelta ?? 0);
    if (!lines) return undefined;
    this.scroll(tab, -lines);
    return { handled: true, render: true };
  }

  /** Positive `lines` scroll back towards the start of the transcript. */
  private scroll(tab: Tab, lines: number): void {
    tab.scrollBack = Math.max(0, tab.scrollBack + lines);
    this.tui.requestRender();
  }

  private bodyHeight(): number {
    return Math.max(1, this.tui.terminal.rows - 8);
  }

  invalidate(): void {
    for (const tab of this.tabs()) tab.transcript.invalidate();
    for (const editor of this.editors.values()) editor.invalidate();
  }

  dispose(): void {
    clearInterval(this.timer);
    this.unsubscribe();
  }

  private tabBar(width: number): string {
    const t = this.theme;
    const labels = [` ${t.fg("muted", "1 main")} `];
    this.tabs().forEach((tab, i) => {
      const marker = tab.marker(t);
      const name = `${i + 2} ${tab.branch}`;
      labels.push(
        i === this.index
          ? ` ${t.bg("selectedBg", t.bold(t.fg("accent", ` ${name} `)))}${marker} `
          : ` ${t.fg("muted", name)} ${marker} `,
      );
    });
    return fit(labels.join(t.fg("borderMuted", "│")), width);
  }

  private statusLine(tab: Tab, width: number): string {
    const t = this.theme;
    const left =
      this.error !== undefined
        ? t.fg("error", this.error)
        : tab.agent.state.kind === "dead"
          ? t.fg("error", `Agent ${tab.agent.state.reason}`)
          : tab.agent.state.kind === "starting"
            ? t.fg("muted", "Starting…")
            : tab.agent.running
              ? t.fg("accent", `${SPINNER[this.frame % SPINNER.length]} Working… `) + t.fg("dim", "(Esc to abort)")
              : "";
    const right = [...tab.agent.statuses.values()].join(" ");
    const gap = width - visibleWidth(left) - visibleWidth(right);
    return gap >= 1 ? left + " ".repeat(gap) + right : fit(left, width);
  }

  render(width: number): string[] {
    const tab = this.tab;
    const height = Math.max(4, this.tui.terminal.rows);
    if (!tab) return [this.tabBar(width)];
    const t = this.theme;
    const header = fit(t.fg("dim", ` ${home(tab.dir)}${tab.model ? ` · ${tab.model}` : ""}`), width);
    const editorLines = this.editor(tab).render(width);
    const hints = fit(
      t.fg(
        "dim",
        " Enter send/steer · Esc abort or main · Alt+1 main · Alt+2-9 tab · Alt+W next · PgUp/PgDn scroll · Ctrl+O tools",
      ),
      width,
    );
    const status = this.statusLine(tab, width);
    const bodyHeight = Math.max(0, height - 2 - 1 - editorLines.length - 1);
    const body = tab.transcript.render(width);
    tab.scrollBack = Math.min(tab.scrollBack, Math.max(0, body.length - bodyHeight));
    const end = body.length - tab.scrollBack;
    const visible = body.slice(Math.max(0, end - bodyHeight), end).map((line) => fit(line, width));
    while (visible.length < bodyHeight) visible.unshift(" ".repeat(width));
    return [this.tabBar(width), header, ...visible, status, ...editorLines, hints].slice(0, height);
  }
}
