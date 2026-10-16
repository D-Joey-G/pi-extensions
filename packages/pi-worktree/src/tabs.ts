import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { Agent, type RpcRecord, type UiAnswer, type UiRequest } from "./agent.ts";
import type { Worktree } from "./git.ts";
import { Transcript } from "./transcript.ts";
import type { TabsView } from "./view.ts";

/** One worktree agent and the state its tab keeps between views. */
export class Tab {
  readonly agent: Agent;
  readonly transcript: Transcript;
  model: string | undefined;
  /** Lines scrolled up from the end of the transcript; 0 follows new output. */
  scrollBack = 0;
  /** Finished a run the user has not looked at yet. */
  unread = false;

  constructor(
    readonly worktree: Worktree,
    args: string[],
    tui: TUI,
    onUi: (request: UiRequest) => Promise<UiAnswer>,
  ) {
    this.agent = new Agent(worktree.dir, args, onUi);
    this.transcript = new Transcript(tui, worktree.dir);
    this.agent.onRecord((record) => this.transcript.handle(record));
  }

  get branch(): string {
    return this.worktree.branch;
  }

  get dir(): string {
    return this.worktree.dir;
  }

  /** Loads history and model once the child answers. */
  async ready(): Promise<void> {
    const state = this.agent.request<{ model?: { provider: string; id: string }; thinkingLevel?: string }>({
      type: "get_state",
    });
    // The snapshot covers every event before its response and none after, so load it right there.
    await this.agent.request<{ messages: never[] }>({ type: "get_messages" }, ({ messages }) =>
      this.transcript.load(messages),
    );
    const { model, thinkingLevel } = await state;
    if (model) this.model = `${model.provider}/${model.id}${thinkingLevel ? `:${thinkingLevel}` : ""}`;
  }

  /** ✗ exited, ● working, ✓ finished unseen, ○ idle. */
  marker(theme: Theme): string {
    if (this.agent.dead) return theme.fg("error", "✗");
    if (this.agent.running) return theme.fg("warning", "●");
    return this.unread ? theme.fg("success", "✓") : theme.fg("dim", "○");
  }

  follow(): void {
    this.scrollBack = 0;
  }
}

/** Notifies on every record from any tab, so the view and the footer status stay current. */
export type TabListener = (tab: Tab, record: RpcRecord) => void;

/**
 * Tabs outlive one extension runtime: `/reload`, `/new` and `/resume` rebuild extensions,
 * but the worktree agents keep running, so the registry lives on `globalThis`.
 * Callbacks attached to agents read state only from here, whichever runtime attached them.
 */
export interface Registry {
  tabs: Tab[];
  ctx: ExtensionContext | undefined;
  tui: TUI | undefined;
  /** The open tab view, if any. */
  view: TabsView | undefined;
  /** The tab shown when the view last closed, reopened by Alt+W. */
  lastTab: Tab | undefined;
  /** Forwarded dialogs, shown one at a time; `reopen` is the tab to show again once all are answered. */
  dialogs: { queue: Promise<unknown>; pending: number; reopen: Tab | undefined };
  listeners: Set<TabListener>;
}

const KEY = Symbol.for("@djoeyg/pi-worktree");

export function registry(): Registry {
  const store = globalThis as { [KEY]?: Registry };
  return (store[KEY] ??= {
    tabs: [],
    ctx: undefined,
    tui: undefined,
    view: undefined,
    lastTab: undefined,
    dialogs: { queue: Promise.resolve(), pending: 0, reopen: undefined },
    listeners: new Set(),
  });
}
