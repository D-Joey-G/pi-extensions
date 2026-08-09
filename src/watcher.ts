import { join } from "node:path";
import { type FSWatcher, watch } from "chokidar";
import { DEFAULT_IGNORE, type PairConfig } from "./config.js";
import { makeWorkspaceIgnoreMatcher } from "./ignore.js";

export interface EditBurst {
  /** Absolute paths touched since the previous burst. */
  paths: string[];
  at: number;
}

/** Files discovered by the initial scan, so the snapshot can take a baseline. */
export interface WatcherReady {
  files: string[];
  /** True when the scan hit `maxSeedFiles` and some files have no baseline. */
  truncated: boolean;
}

/** Guard against seeding a monorepo's worth of files into memory at startup. */
const MAX_SEED_FILES = 5000;

/**
 * Watches the repo and emits a burst once the driver stops typing.
 *
 * Editors save constantly — on keystroke, on blur, via temp-file rename — so a
 * settle window is what turns raw fs noise into "the driver paused, go look".
 */
export class EditWatcher {
  private watcher: FSWatcher | undefined;
  private pending = new Set<string>();
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly root: string,
    private readonly config: PairConfig,
    private readonly onBurst: (burst: EditBurst) => void | Promise<void>,
    private readonly onEdit?: (at: number) => void,
    /** Called when the watcher dies after startup, so the failure is not silent. */
    private readonly onError?: (error: Error) => void,
  ) {}

  /**
   * Starts watching and resolves once the initial scan is done.
   *
   * Callers must await this: chokidar emits nothing until it is ready, so an
   * edit made in the gap between `watch()` and `ready` is silently dropped.
   */
  async start(): Promise<WatcherReady> {
    if (this.watcher) return { files: [], truncated: false };

    const ignored = await makeWorkspaceIgnoreMatcher(this.root, [...DEFAULT_IGNORE, ...this.config.ignore]);
    const watcher = watch(this.root, {
      ignored,
      ignoreInitial: true,
      persistent: true,
      // Do not follow repository symlinks into files the driver never intended
      // this workspace (or the model) to inspect.
      followSymlinks: false,
      // Editors write via temp file + rename; wait for the size to hold still.
      awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
    });
    this.watcher = watcher;

    const touch = (path: string) => this.record(path);
    watcher.on("add", touch).on("change", touch).on("unlink", touch);

    await new Promise<void>((resolve, reject) => {
      watcher.once("ready", () => resolve());
      watcher.once("error", (error) => reject(error));
    });

    // Past startup a dead watcher would silently end the pairing loop while the
    // widget still claimed to be watching, so tear down and tell the caller.
    watcher.on("error", (error) => {
      void this.stop();
      this.onError?.(error instanceof Error ? error : new Error(String(error)));
    });

    // getWatched() lists every watched directory and its entries, where an
    // entry may itself be a directory. A directory is exactly an entry that
    // also appears as a key, which is cheaper than stat-ing the whole tree.
    const watched = watcher.getWatched();
    const directories = new Set(Object.keys(watched));
    const files: string[] = [];
    let truncated = false;
    for (const [dir, names] of Object.entries(watched)) {
      for (const name of names) {
        const path = join(dir, name);
        if (directories.has(path) || ignored(path)) continue;
        if (files.length >= MAX_SEED_FILES) {
          truncated = true;
          break;
        }
        files.push(path);
      }
      if (truncated) break;
    }
    return { files, truncated };
  }

  private record(path: string): void {
    this.pending.add(path);
    this.onEdit?.(Date.now());
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      void this.flush().catch((error) => this.onError?.(error instanceof Error ? error : new Error(String(error))));
    }, this.config.settleMs);
    // Never hold the process open on the settle timer alone.
    this.timer.unref?.();
  }

  /** Removes and returns pending paths without emitting a burst. */
  takePending(): string[] {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    const paths = [...this.pending];
    this.pending.clear();
    return paths;
  }

  /** Emits whatever has accumulated, ignoring the settle window. */
  async flush(): Promise<void> {
    const paths = this.takePending();
    if (paths.length === 0) return;
    await this.onBurst({ paths, at: Date.now() });
  }

  async stop(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.pending.clear();
    const watcher = this.watcher;
    this.watcher = undefined;
    await watcher?.close();
  }
}
