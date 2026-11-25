import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";

/** A named launch preset for the agent tool, read from a markdown file. */
export type Mode = {
  name: string;
  description: string;
  model?: string;
  readOnly?: boolean;
  tools?: string[];
  /** Skill names, or absolute paths to skill files or directories. */
  skills: string[];
  /** Appended to the child's system prompt. */
  prompt: string;
  path: string;
};

export type ModeCatalog = {
  modes: Map<string, Mode>;
  /** One line per malformed file, naming it. */
  problems: string[];
};

/** What the caller asked for; each set field overrides the mode's. */
export type LaunchArgs = {
  model?: string;
  readOnly?: boolean;
  tools?: string[];
  skills?: string[];
};

export type Launch = {
  model: string;
  readOnly: boolean;
  /** Value for pi's --tools. */
  tools: string;
  skills: string[];
  prompt: string;
};

export const DEFAULT_MODEL = "openai/gpt-6.1-terra";
const READ_ONLY_TOOLS = ["read", "bash", "ffgrep", "fffind", "write", "intercom"];
// The child must always be able to write its report and signal the parent.
const REQUIRED_TOOLS = ["write", "intercom"];
// Pi's defaults plus intercom; no grandchildren.
const WRITABLE_TOOLS_SPEC = "+intercom,-agent";
const FIELDS = new Set(["name", "description", "model", "readOnly", "tools", "skills"]);

export const BUILTIN_MODES_DIR = join(dirname(fileURLToPath(import.meta.url)), "modes");

export function expandPath(base: string, path: string): string {
  return resolve(base, path.replace(/^~(?=$|\/)/, homedir()));
}

/** Names stay names; anything that looks like a path is resolved against `base`. */
export function isSkillPath(entry: string): boolean {
  return entry.includes("/") || entry.startsWith("~") || entry.startsWith(".") || entry.endsWith(".md");
}

function stringList(value: unknown, field: string): string[] {
  const items = typeof value === "string" ? value.split(",") : value;
  if (!Array.isArray(items) || !items.every((x) => typeof x === "string")) {
    throw new Error(`${field} must be a list of strings or a comma-separated string`);
  }
  return items.map((x) => x.trim()).filter(Boolean);
}

export function parseMode(path: string, content: string): Mode {
  try {
    const { frontmatter: fm, body } = parseFrontmatter(content);
    if (typeof fm !== "object" || Array.isArray(fm)) throw new Error("frontmatter must be a YAML mapping");
    const unknown = Object.keys(fm).filter((k) => !FIELDS.has(k));
    if (unknown.length) throw new Error(`unknown field(s) ${unknown.join(", ")}; allowed: ${[...FIELDS].join(", ")}`);
    if (typeof fm.name !== "string" || !/^[\w-]+$/.test(fm.name)) {
      throw new Error("name is required: letters, digits, _ and - only");
    }
    if (typeof fm.description !== "string" || !fm.description.trim()) throw new Error("description is required");
    if (fm.model !== undefined && (typeof fm.model !== "string" || !fm.model.trim())) {
      throw new Error("model must be a provider/id[:thinking] string");
    }
    if (fm.readOnly !== undefined && typeof fm.readOnly !== "boolean")
      throw new Error("readOnly must be true or false");
    return {
      name: fm.name,
      description: fm.description.trim(),
      model: fm.model?.trim(),
      readOnly: fm.readOnly,
      tools: fm.tools === undefined ? undefined : stringList(fm.tools, "tools"),
      skills: (fm.skills === undefined ? [] : stringList(fm.skills, "skills")).map((s) =>
        isSkillPath(s) ? expandPath(dirname(path), s) : s,
      ),
      prompt: body,
      path,
    };
  } catch (err) {
    throw new Error(`Invalid agent mode ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Reads `*.md` from each directory in order; a later mode replaces an earlier one with the same name. */
export function discoverModes(dirs: string[]): ModeCatalog {
  const modes = new Map<string, Mode>();
  const problems: string[] = [];
  for (const dir of dirs) {
    if (!existsSync(dir) || !statSync(dir).isDirectory()) continue;
    for (const file of readdirSync(dir)
      .filter((f) => f.endsWith(".md"))
      .sort()) {
      const path = join(dir, file);
      try {
        const mode = parseMode(path, readFileSync(path, "utf8"));
        modes.set(mode.name, mode);
      } catch (err) {
        problems.push(err instanceof Error ? err.message : String(err));
      }
    }
  }
  return { modes, problems };
}

/** Built-ins, then the user's, then the project's when it is trusted. */
export function modeDirs(agentDir: string, cwd: string | undefined): string[] {
  return [BUILTIN_MODES_DIR, join(agentDir, "agent-modes"), ...(cwd ? [join(cwd, ".pi", "agent-modes")] : [])];
}

export function findMode(catalog: ModeCatalog, name: string): Mode {
  const mode = catalog.modes.get(name);
  if (mode) return mode;
  const known = [...catalog.modes.keys()].join(", ") || "none";
  const broken = catalog.problems.length ? `\nMalformed mode files:\n${catalog.problems.join("\n")}` : "";
  throw new Error(`Unknown agent mode "${name}". Available: ${known}.${broken}`);
}

/** Merges explicit args over the mode, field by field, then over the defaults. */
export function resolveLaunch(args: LaunchArgs, mode: Mode | undefined): Launch {
  const readOnly = args.readOnly ?? mode?.readOnly ?? true;
  const tools = args.tools ?? mode?.tools;
  return {
    model: args.model?.trim() || mode?.model || DEFAULT_MODEL,
    readOnly,
    tools: tools
      ? [...new Set([...tools, ...REQUIRED_TOOLS])].join(",")
      : readOnly
        ? READ_ONLY_TOOLS.join(",")
        : WRITABLE_TOOLS_SPEC,
    skills: args.skills ?? mode?.skills ?? [],
    prompt: mode?.prompt ?? "",
  };
}

/**
 * Returns the skill file to load. `known` maps discovered skill names to their files;
 * paths are taken relative to `base`, and a directory means its SKILL.md.
 */
export function resolveSkill(entry: string, base: string, known: Map<string, string>): string {
  if (!isSkillPath(entry)) {
    const file = known.get(entry);
    if (!file) throw new Error(`Unknown skill "${entry}". Known: ${[...known.keys()].sort().join(", ") || "none"}`);
    return file;
  }
  const path = expandPath(base, entry);
  if (!existsSync(path)) throw new Error(`Skill path does not exist: ${path}`);
  return statSync(path).isDirectory() ? join(path, "SKILL.md") : path;
}

export function describeModes(catalog: ModeCatalog): string {
  const lines = [...catalog.modes.values()].map((m) => {
    const access = m.tools ? `tools ${m.tools.join(",")}` : m.readOnly === false ? "read-write" : "read-only";
    return `- ${m.name}: ${m.description} (${m.model ?? DEFAULT_MODEL}, ${access})`;
  });
  return lines.join("\n");
}
