/** Loads built-in and user-defined entries. Later sources override earlier ones by name. */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { Entry, EntryKind } from "./match.ts";

export type Scope = "user" | "project";

const dataDir = join(dirname(fileURLToPath(import.meta.url)), "..", "data");

export const customPath = (scope: Scope, cwd: string) =>
	scope === "user" ? join(getAgentDir(), "emoji.json") : join(cwd, ".pi", "emoji.json");

function readMap(path: string): Record<string, string> {
	if (!existsSync(path)) return {};
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
		return Object.fromEntries(Object.entries(parsed).filter((pair): pair is [string, string] => typeof pair[1] === "string"));
	} catch {
		return {};
	}
}

const builtIns = (): Map<string, Entry> => {
	const entries = new Map<string, Entry>();
	const add = (map: Record<string, string>, kind: EntryKind) => {
		for (const [name, value] of Object.entries(map)) entries.set(name, { name, value, kind });
	};
	add(readMap(join(dataDir, "emoji.json")), "emoji");
	add(readMap(join(dataDir, "kaomoji.json")), "kaomoji");
	return entries;
};

const builtInCache = builtIns();

export function loadCustom(scope: Scope, cwd: string): Record<string, string> {
	return readMap(customPath(scope, cwd));
}

export function saveCustom(scope: Scope, cwd: string, map: Record<string, string>): void {
	const path = customPath(scope, cwd);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(map, null, "\t")}\n`);
}

export function loadEntries(cwd: string): Entry[] {
	const entries = new Map(builtInCache);
	for (const scope of ["user", "project"] as const) {
		for (const [name, value] of Object.entries(loadCustom(scope, cwd))) entries.set(name, { name, value, kind: "custom" });
	}
	return [...entries.values()];
}
