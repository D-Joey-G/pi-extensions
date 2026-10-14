import { DynamicBorder, getMarkdownTheme, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Container, Key, Markdown, matchesKey, SelectList, Text, type SelectItem } from "@earendil-works/pi-tui";
import type { FeedbackFilter } from "./filter.ts";
import { filterFeedback } from "./filter.ts";
import { formatPreview, itemDescription, itemLabel } from "./format.ts";
import type { FeedbackItem } from "./types.ts";

const FILTERS: FeedbackFilter[] = ["all", "unresolved", "resolved"];

function filterPrefix(item: FeedbackItem): string {
  if (item.kind !== "inline") return "other";
  return item.resolved ? "resolved" : "unresolved";
}

export type FeedbackSelection = { mode: "single"; item: FeedbackItem } | { mode: "unresolved"; items: FeedbackItem[] };

export async function showFeedbackBrowser(
  ctx: ExtensionCommandContext,
  heading: string,
  items: FeedbackItem[],
): Promise<FeedbackSelection | undefined> {
  const selection = await ctx.ui.custom<FeedbackSelection | null>((tui, theme, _keybindings, done) => {
    const container = new Container();
    const border = new DynamicBorder((text: string) => theme.fg("accent", text));
    let filter: FeedbackFilter = "all";
    const selectItems: SelectItem[] = items.map((item) => ({
      value: `${filterPrefix(item)}:${item.id}`,
      label: itemLabel(item),
      description: itemDescription(item),
    }));
    const list = new SelectList(selectItems, Math.min(items.length, 8), {
      selectedPrefix: (text) => theme.fg("accent", text),
      selectedText: (text) => theme.fg("accent", text),
      description: (text) => theme.fg("muted", text),
      scrollInfo: (text) => theme.fg("dim", text),
      noMatch: () => theme.fg("warning", "  No comments match this filter"),
    });
    const title = new Text("", 1, 0);
    const preview = new Markdown(formatPreview(items[0]!), 1, 1, getMarkdownTheme());
    const itemForValue = (value: string) => {
      const id = value.slice(value.indexOf(":") + 1);
      return items.find((candidate) => candidate.id === id);
    };
    const updateTitle = () => {
      const shown = filterFeedback(items, filter).length;
      title.setText(
        theme.fg("accent", theme.bold(heading)) +
          theme.fg("muted", ` · filter: ${filter} · ${shown}/${items.length} item(s)`),
      );
    };
    const updatePreview = () => {
      const selection = list.getSelectedItem();
      const item = selection ? itemForValue(selection.value) : undefined;
      preview.setText(item ? formatPreview(item) : "_No comments match this filter._");
    };

    updateTitle();
    list.onSelectionChange = (selection) => {
      const item = itemForValue(selection.value);
      if (item) preview.setText(formatPreview(item));
      tui.requestRender();
    };
    list.onSelect = (selection) => {
      const item = itemForValue(selection.value);
      done(item ? { mode: "single", item } : null);
    };
    list.onCancel = () => done(null);

    container.addChild(border);
    container.addChild(title);
    container.addChild(list);
    container.addChild(new Text(theme.fg("dim", "Selected feedback"), 1, 1));
    container.addChild(preview);
    container.addChild(
      new Text(theme.fg("dim", "↑↓ browse • tab filter • enter send one • a edit/send unresolved • esc cancel"), 1, 0),
    );
    container.addChild(border);

    return {
      render: (width: number) => container.render(width),
      invalidate: () => container.invalidate(),
      handleInput: (data: string) => {
        if (matchesKey(data, Key.tab)) {
          filter = FILTERS[(FILTERS.indexOf(filter) + 1) % FILTERS.length]!;
          list.setFilter(filter === "all" ? "" : `${filter}:`);
          updateTitle();
          updatePreview();
        } else if (data === "a") {
          const unresolved = filterFeedback(items, "unresolved");
          if (unresolved.length > 0) done({ mode: "unresolved", items: unresolved });
        } else {
          list.handleInput(data);
        }
        tui.requestRender();
      },
    };
  });

  return selection ?? undefined;
}
