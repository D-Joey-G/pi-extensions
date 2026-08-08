import { relative, sep } from "node:path";

/**
 * Minimal glob-to-regex for ignore patterns.
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
    const rel = relative(root, absolutePath).split(sep).join("/");
    // Outside the root, or the root itself.
    if (rel.startsWith("..")) return true;
    if (rel === "") return false;
    return regexes.some((regex) => regex.test(rel));
  };
}
