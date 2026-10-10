// Regenerates data/emoji.json from emojibase-data.
// Usage: node scripts/generate-emoji.mjs <path-to-emojibase-data/en>
// Slack's shortcodes (iamcal) win name clashes, then GitHub's, then CLDR's.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2];
if (!dir) throw new Error("usage: generate-emoji.mjs <emojibase-data/en dir>");

const read = (file) => JSON.parse(readFileSync(join(dir, file), "utf8"));
const compact = read("compact.json");
const sets = ["iamcal", "github", "cldr"].map((name) => read(`shortcodes/${name}.json`));

const out = {};
const seen = new Set(); // `_` and `-` spellings are the same name to the extension
for (const emoji of compact) {
	for (const set of sets) {
		const codes = set[emoji.hexcode];
		if (!codes) continue;
		for (const code of [codes].flat()) {
			const name = code.toLowerCase();
			const key = name.replace(/_/g, "-");
			if (seen.has(key)) continue;
			seen.add(key);
			out[name] = emoji.unicode;
		}
	}
}

const sorted = Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
writeFileSync(new URL("../data/emoji.json", import.meta.url), `${JSON.stringify(sorted, null, "\t")}\n`);
console.log(`${Object.keys(sorted).length} shortcodes`);
