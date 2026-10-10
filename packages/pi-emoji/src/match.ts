/** Pure helpers: find the `:name` token before the cursor and rank entries against it. */

export type EntryKind = "emoji" | "kaomoji" | "custom";

export interface Entry {
  name: string;
  value: string;
  kind: EntryKind;
}

const MIN_QUERY_LENGTH = 2;
export const MAX_RESULTS = 20;

/** `_` and `-` are interchangeable so `:thumbs_up` and `:elmo-fire` both feel natural. */
export const normalize = (name: string) => name.toLowerCase().replace(/_/g, "-");

/** Returns the `:query` text (colon included) ending at the cursor, only at a word boundary. */
export function findToken(line: string, cursorCol: number): string | undefined {
  const before = line.slice(0, cursorCol);
  const match = /(?:^|[\s([{"'])(:[\w+-]+)$/u.exec(before);
  const token = match?.[1];
  return token && token.length - 1 >= MIN_QUERY_LENGTH ? token : undefined;
}

export function search(entries: readonly Entry[], token: string): Entry[] {
  const query = normalize(token.slice(1));
  const ranked: { entry: Entry; rank: number }[] = [];
  for (const entry of entries) {
    const name = normalize(entry.name);
    const index = name.indexOf(query);
    if (index === -1) continue;
    const rank = name === query ? 0 : index === 0 ? 1 : 2;
    ranked.push({ entry, rank });
  }
  ranked.sort(
    (a, b) => a.rank - b.rank || a.entry.name.length - b.entry.name.length || a.entry.name.localeCompare(b.entry.name),
  );
  return ranked.slice(0, MAX_RESULTS).map(({ entry }) => entry);
}
