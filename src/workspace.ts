import { open, readFile, stat } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { createTwoFilesPatch } from "diff";
import type { PairConfig } from "./config.js";
import type { ObservedFile } from "./types.js";

const BINARY_SNIFF_BYTES = 8000;

type FileSnapshot = { kind: "text"; content: string } | { kind: "opaque"; fingerprint: string; description: string };

/**
 * Holds the content of every watched file as of the navigator's last look.
 *
 * The baseline is the working tree at session start rather than git HEAD, so
 * the navigator sees exactly the work done during this pairing session and not
 * whatever the driver had already left uncommitted when they sat down.
 */
export class WorkspaceSnapshot {
  private readonly contents = new Map<string, FileSnapshot>();

  constructor(
    readonly root: string,
    private readonly config: PairConfig,
  ) {}

  /** Diffs the given absolute paths against the snapshot without advancing it. */
  async diff(absPaths: string[]): Promise<ObservedFile[]> {
    const observed: ObservedFile[] = [];
    for (const abs of absPaths) {
      const path = this.toRelative(abs);
      if (!path) continue;

      const current = await readFileSnapshot(abs, this.config.maxFileBytes);
      const previous = this.contents.get(path);

      if (sameSnapshot(current, previous)) continue;
      if (current === undefined && previous === undefined) continue;

      const status = current === undefined ? "deleted" : previous === undefined ? "added" : "modified";
      if (current?.kind === "text" && (previous === undefined || previous.kind === "text")) {
        const patch = createTwoFilesPatch(
          status === "added" ? "/dev/null" : `a/${path}`,
          status === "deleted" ? "/dev/null" : `b/${path}`,
          previous?.content ?? "",
          current.content,
          undefined,
          undefined,
          { context: 3 },
        );
        observed.push(toObservedFile(path, status, stripPatchPreamble(patch), this.config.maxPatchLines));
        continue;
      }
      if (current === undefined && previous?.kind === "text") {
        const patch = createTwoFilesPatch(`a/${path}`, "/dev/null", previous.content, "", undefined, undefined, {
          context: 3,
        });
        observed.push(toObservedFile(path, status, stripPatchPreamble(patch), this.config.maxPatchLines));
        continue;
      }

      const before = describeSnapshot(previous);
      const after = describeSnapshot(current);
      observed.push({
        path,
        status,
        patch: `(content diff unavailable: ${before} → ${after})`,
        addedLines: current === undefined ? 0 : 1,
        removedLines: previous === undefined ? 0 : 1,
      });
    }
    return observed.sort((a, b) => b.addedLines + b.removedLines - (a.addedLines + a.removedLines));
  }

  /** Advances the snapshot so the next diff only covers changes made after now. */
  async commit(absPaths: string[]): Promise<void> {
    for (const abs of absPaths) {
      const path = this.toRelative(abs);
      if (!path) continue;
      const current = await readFileSnapshot(abs, this.config.maxFileBytes);
      if (current === undefined) this.contents.delete(path);
      else this.contents.set(path, current);
    }
  }

  /** Seeds the baseline from the files that already exist. */
  async seed(absPaths: string[]): Promise<void> {
    await this.commit(absPaths);
  }

  /** Seeds only files that were not watched before a live ignore-rule change. */
  async seedMissing(absPaths: string[]): Promise<void> {
    for (const abs of absPaths) {
      const path = this.toRelative(abs);
      if (!path || this.contents.has(path)) continue;
      const current = await readFileSnapshot(abs, this.config.maxFileBytes);
      if (current !== undefined) this.contents.set(path, current);
    }
  }

  /** Resolves a snapshot-relative path back to disk, for `commit` after a diff. */
  toAbsolute(path: string): string {
    return resolve(this.root, path);
  }

  /** Converts a path to a safe snapshot-relative path. */
  toRelative(abs: string): string | undefined {
    const path = relative(this.root, abs);
    if (!path || path === ".." || path.startsWith("../")) return undefined;
    return path;
  }
}

async function readFileSnapshot(abs: string, maxBytes: number): Promise<FileSnapshot | undefined> {
  try {
    const metadata = await stat(abs);
    if (!metadata.isFile()) return undefined;
    const fingerprint = `${metadata.size}:${metadata.mtimeMs}`;
    if (metadata.size > maxBytes) {
      return { kind: "opaque", fingerprint, description: `${metadata.size} bytes (limit ${maxBytes})` };
    }

    const handle = await open(abs, "r");
    try {
      const sniff = Buffer.alloc(Math.min(BINARY_SNIFF_BYTES, metadata.size));
      if (sniff.length > 0) await handle.read(sniff, 0, sniff.length, 0);
      if (sniff.includes(0)) return { kind: "opaque", fingerprint, description: `binary, ${metadata.size} bytes` };
    } finally {
      await handle.close();
    }
    return { kind: "text", content: await readFile(abs, "utf8") };
  } catch {
    return undefined;
  }
}

function sameSnapshot(a: FileSnapshot | undefined, b: FileSnapshot | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  if (a.kind !== b.kind) return false;
  return a.kind === "text" ? a.content === (b as typeof a).content : a.fingerprint === (b as typeof a).fingerprint;
}

function describeSnapshot(snapshot: FileSnapshot | undefined): string {
  if (snapshot === undefined) return "missing";
  return snapshot.kind === "text" ? "text" : snapshot.description;
}

function toObservedFile(
  path: string,
  status: ObservedFile["status"],
  patch: string,
  maxPatchLines: number,
): ObservedFile {
  const { added, removed } = countLines(patch);
  return {
    path,
    status,
    patch: truncatePatch(patch, maxPatchLines),
    addedLines: added,
    removedLines: removed,
  };
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
