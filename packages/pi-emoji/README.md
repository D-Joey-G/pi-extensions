# @djoeyg/pi-emoji

Slack-style emoji for [pi](https://github.com/earendil-works/pi). Type `:` plus a few letters and pick from the popup; the emoji is inserted as plain text.

```sh
pi install npm:@djoeyg/pi-emoji
```

## Usage

- `:tada` → pick `🎉 :tada:`. Names ignore `_` vs `-`, so `:thumbs_up` and `:thumbs-up` both match.
- Kaomoji use the same mechanism: `:shrug` → `¯\_(ツ)_/¯`, `:tableflip`, `:lenny`, ...
- Completion only starts at a word boundary after at least two characters, so `http://`, `10:30` and `foo::bar` are left alone.

## Custom entries

Run `/emoji` to add, remove or list entries. They are stored as a flat JSON map of name to replacement text:

- `~/.pi/agent/emoji.json` for all projects
- `.pi/emoji.json` for one project (overrides user entries)

```json
{ "elmo-fire": "🔥", "ship-it": "🚢 (ง'̀-'́)ง" }
```

Custom names override built-ins. Slack-style image emoji such as `:elmo-fire:` cannot be rendered in a terminal, so map them to any text you like.

## Data

`data/emoji.json` is generated from [emojibase](https://github.com/milesj/emojibase) shortcodes (Slack, GitHub and CLDR sets merged, Slack names win): `node scripts/generate-emoji.mjs <emojibase-data/en>`. Skin-tone variants are not included.
