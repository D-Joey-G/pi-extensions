/**
 * Emoji extension - type `:name` in the editor to pick an emoji or kaomoji, like Slack.
 *
 * Completions come from a vendored emoji shortcode set, a small kaomoji set, and custom entries in
 * `~/.pi/agent/emoji.json` and `.pi/emoji.json`. The chosen replacement is inserted as plain text,
 * so the agent reads the emoji itself. Manage custom entries with `/emoji`.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type Entry, findToken, search } from "./match.ts";
import { type Scope, customPath, loadCustom, loadEntries, saveCustom } from "./store.ts";

/** Autocomplete item values are replacement text, so remember which items are ours. */
const ownItems = new WeakSet<object>();

const describe = (entry: Entry) => (entry.kind === "emoji" ? "" : entry.kind);

export default function emojiExtension(pi: ExtensionAPI) {
  let entries: Entry[] = [];
  let cwd = process.cwd();

  const reload = (ctx: ExtensionContext) => {
    cwd = ctx.cwd;
    entries = loadEntries(cwd);
  };

  pi.on("session_start", (_event, ctx) => {
    reload(ctx);
    ctx.ui.addAutocompleteProvider((current) => ({
      triggerCharacters: [...new Set([...(current.triggerCharacters ?? []), ":"])],
      async getSuggestions(lines, cursorLine, cursorCol, options) {
        const token = findToken(lines[cursorLine] ?? "", cursorCol);
        const matches = token ? search(entries, token) : [];
        if (!token || matches.length === 0) return current.getSuggestions(lines, cursorLine, cursorCol, options);
        const items = matches.map((entry) => {
          const item = { value: entry.value, label: `${entry.value}  :${entry.name}:`, description: describe(entry) };
          ownItems.add(item);
          return item;
        });
        return { items, prefix: token };
      },
      applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
        if (!ownItems.has(item)) return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
        const line = lines[cursorLine] ?? "";
        const start = cursorCol - prefix.length;
        const next = [...lines];
        next[cursorLine] = line.slice(0, start) + item.value + line.slice(cursorCol);
        return { lines: next, cursorLine, cursorCol: start + item.value.length };
      },
      shouldTriggerFileCompletion: current.shouldTriggerFileCompletion?.bind(current),
    }));
  });

  pi.registerCommand("emoji", {
    description: "Add, remove, or list custom emoji / kaomoji for :name completion",
    handler: async (_args, ctx) => {
      const action = await ctx.ui.select("Custom emoji", ["Add", "Remove", "List"]);
      if (action === "Add") await addEntry(ctx);
      else if (action === "Remove") await removeEntry(ctx);
      else if (action === "List") listEntries(ctx);
      reload(ctx);
    },
  });
}

async function pickScope(ctx: ExtensionContext): Promise<Scope | undefined> {
  const choice = await ctx.ui.select("Where should it be saved?", [
    `User (${customPath("user", ctx.cwd)})`,
    `Project (${customPath("project", ctx.cwd)})`,
  ]);
  return choice === undefined ? undefined : choice.startsWith("User") ? "user" : "project";
}

async function addEntry(ctx: ExtensionContext) {
  const rawName = (await ctx.ui.input("Name (used as :name)", "elmo-fire"))?.trim().replace(/^:|:$/g, "");
  if (!rawName) return;
  if (!/^[\w+-]+$/u.test(rawName)) {
    ctx.ui.notify("Names may only contain letters, digits, _, - and +", "error");
    return;
  }
  const value = (await ctx.ui.input(`Text inserted for :${rawName}`, "🔥"))?.trim();
  if (!value) return;
  const scope = await pickScope(ctx);
  if (!scope) return;
  saveCustom(scope, ctx.cwd, { ...loadCustom(scope, ctx.cwd), [rawName]: value });
  ctx.ui.notify(`Saved :${rawName} → ${value}`, "info");
}

async function removeEntry(ctx: ExtensionContext) {
  const scope = await pickScope(ctx);
  if (!scope) return;
  const map = loadCustom(scope, ctx.cwd);
  const labels = Object.entries(map).map(([name, value]) => `${name}  ${value}`);
  if (labels.length === 0) {
    ctx.ui.notify("No custom entries in that file", "info");
    return;
  }
  const choice = await ctx.ui.select("Remove which entry?", labels);
  if (!choice) return;
  const name = Object.keys(map)[labels.indexOf(choice)];
  if (name === undefined) return;
  const { [name]: _removed, ...rest } = map;
  saveCustom(scope, ctx.cwd, rest);
  ctx.ui.notify(`Removed :${name}`, "info");
}

function listEntries(ctx: ExtensionContext) {
  const lines = (["user", "project"] as const).flatMap((scope) =>
    Object.entries(loadCustom(scope, ctx.cwd)).map(([name, value]) => `:${name}: ${value}  (${scope})`),
  );
  ctx.ui.notify(lines.length > 0 ? lines.join("\n") : "No custom entries yet. Use /emoji → Add.", "info");
}
