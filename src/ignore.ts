import { readdir, readFile } from "node:fs/promises";
import { relative, sep } from "node:path";
import ignore, { type Ignore } from "ignore";

/**
 * Minimal glob-to-regex for user-supplied ignore patterns.
 *
 * chokidar dropped glob support in v4, so patterns like `**\/node_modules/**`
 * passed straight to `ignored` are inert and silently match nothing. We keep
 * the familiar glob syntax in config and do the matching ourselves.
 */
export function globToRegExp(pattern: string): RegExp {
  let out = "";
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i]!;
    if (char === "*") {
      if (pattern[i + 1] === "*") {
        // `**/` matches zero or more leading segments; bare `**` matches anything.
        if (pattern[i + 2] === "/") {
          out += "(?:.*/)?";
          i += 2;
        } else {
          out += ".*";
          i += 1;
        }
      } else {
        out += "[^/]*";
      }
      continue;
    }
    if (char === "?") {
      out += "[^/]";
      continue;
    }
    out += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
}

export type IgnoreMatcher = (absolutePath: string) => boolean;

export function makeIgnoreMatcher(root: string, patterns: string[]): IgnoreMatcher {
  const regexes = patterns.map(globToRegExp);
  return (absolutePath: string) => {
    const rel = toRelative(root, absolutePath);
    // Outside the root, or the root itself.
    if (rel === undefined) return true;
    if (rel === "") return false;
    return regexes.some((regex) => regex.test(rel) || regex.test(`${rel}/`));
  };
}

interface IgnoreScope {
  directory: string;
  rules: Ignore;
}

/**
 * Builds the watcher matcher, including root and nested `.gitignore` files.
 *
 * Rules are evaluated from the root toward the file, so a nested negation can
 * override an earlier rule just as it does in git. Built-in and user-supplied
 * safety ignores remain absolute and cannot be negated by repository content.
 */
export async function makeWorkspaceIgnoreMatcher(root: string, patterns: string[]): Promise<IgnoreMatcher> {
  const fixed = makeIgnoreMatcher(root, patterns);
  const scopes: IgnoreScope[] = [];

  const matches = (absolutePath: string): boolean => {
    if (fixed(absolutePath)) return true;
    const rel = toRelative(root, absolutePath);
    if (rel === undefined || rel === "") return rel === undefined;

    let ignored = false;
    for (const scope of scopes) {
      const scoped = toRelative(scope.directory, absolutePath);
      if (scoped === undefined || scoped === "") continue;
      // Testing the slash form as well lets directory-only patterns prune a
      // directory before chokidar descends into it.
      for (const candidate of [scoped, `${scoped}/`]) {
        const result = scope.rules.test(candidate);
        if (result.ignored) ignored = true;
        if (result.unignored) ignored = false;
      }
    }
    return ignored;
  };

  const visit = async (directory: string): Promise<void> => {
    try {
      const contents = await readFile(`${directory}/.gitignore`, "utf8");
      scopes.push({ directory, rules: ignore().add(contents) });
    } catch {
      // Missing and unreadable ignore files simply contribute no rules.
    }

    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    await Promise.all(
      entries
        .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
        .map(async (entry) => {
          const child = `${directory}/${entry.name}`;
          if (!matches(child)) await visit(child);
        }),
    );
  };

  await visit(root);
  return matches;
}

function toRelative(root: string, absolutePath: string): string | undefined {
  const rel = relative(root, absolutePath).split(sep).join("/");
  if (rel === ".." || rel.startsWith("../")) return undefined;
  return rel;
}
