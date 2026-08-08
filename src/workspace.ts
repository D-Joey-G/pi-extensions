import { readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { createTwoFilesPatch } from "diff";
import type { PairConfig } from "./config.js";
import type { ObservedFile } from "./types.js";

const BINARY_SNIFF_BYTES = 8000;

/**
 * Holds the content of every watched file as of the navigator's last look.
 *
 * The baseline is the working tree at session start rather than git HEAD, so
 * the navigator sees exactly the work done during this pairing session and not
 * whatever the driver had already left uncommitted when they sat down.
 */
export class WorkspaceSnapshot {
  private readonly contents = new Map<string, string>();

  constructor(
    readonly root: string,
    private readonly config: PairConfig,
  ) {}

  /** Diffs the given absolute paths against the snapshot without advancing it. */
  async diff(absPaths: string[]): Promise<ObservedFile[]> {
    const observed: ObservedFile[] = [];
    for (const abs of absPaths) {
      const path = relative(this.root, abs);
      if (!path || path.startsWith("..")) continue;

      const current = await readTextFile(abs);
      const previous = this.contents.get(path);

      if (current === undefined && previous === undefined) continue;
      if (current === previous) continue;

      const status = current === undefined ? "deleted" : previous === undefined ? "added" : "modified";
      const patch = createTwoFilesPatch(
        status === "added" ? "/dev/null" : `a/${path}`,
        status === "deleted" ? "/dev/null" : `b/${path}`,
        previous ?? "",
        current ?? "",
        undefined,
        undefined,
        { context: 3 },
      );
      const cleaned = stripPatchPreamble(patch);
      const { added, removed } = countLines(cleaned);
      observed.push({
        path,
        status,
        patch: truncatePatch(cleaned, this.config.maxPatchLines),
        addedLines: added,
        removedLines: removed,
      });
    }
    return observed.sort((a, b) => b.addedLines + b.removedLines - (a.addedLines + a.removedLines));
  }

  /** Advances the snapshot so the next diff only covers changes made after now. */
  async commit(absPaths: string[]): Promise<void> {
    for (const abs of absPaths) {
      const path = relative(this.root, abs);
      if (!path || path.startsWith("..")) continue;
      const current = await readTextFile(abs);
      if (current === undefined) this.contents.delete(path);
      else this.contents.set(path, current);
    }
  }

  /** Seeds the baseline from the files that already exist. */
  async seed(absPaths: string[]): Promise<void> {
    await this.commit(absPaths);
  }

  has(path: string): boolean {
    return this.contents.has(path);
  }

  get size(): number {
    return this.contents.size;
  }

  toAbsolute(path: string): string {
    return resolve(this.root, path);
  }
}

async function readTextFile(abs: string): Promise<string | undefined> {
  try {
    const buffer = await readFile(abs);
    // A NUL byte in the first block is the same heuristic git uses for "binary".
    if (buffer.subarray(0, BINARY_SNIFF_BYTES).includes(0)) return undefined;
    return buffer.toString("utf8");
  } catch {
    return undefined;
  }
}

/** Drops jsdiff's `Index:`/`====` banner, which is pure noise in the prompt. */
export function stripPatchPreamble(patch: string): string {
  return patch
    .split("\n")
    .filter((line) => !/^={5,}$/.test(line) && !line.startsWith("Index: "))
    .join("\n")
    .trimStart();
}

export function countLines(patch: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) added += 1;
    else if (line.startsWith("-")) removed += 1;
  }
  return { added, removed };
}

export function truncatePatch(patch: string, maxLines: number): string {
  const lines = patch.split("\n");
  if (lines.length <= maxLines) return patch;
  const kept = lines.slice(0, maxLines).join("\n");
  return `${kept}\n... (${lines.length - maxLines} more diff lines truncated)`;
}
