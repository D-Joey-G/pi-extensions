import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type Reply, Image, lines } from "./image.ts";
import { installRuntime, installedRuntime } from "./install.ts";

const TOOL_NAMES = ["inspect_world", "define_expression", "execute_expression"];
const MODE_ENTRY = "smalltalk-mode";
const MAX_OUTPUT = 50_000;

interface Mode {
  enabled: boolean;
  /** Tools to give back when the mode is turned off. */
  baselineTools: string[];
}

const GUIDELINES = [
  "You work inside a live, persistent Pharo 13 Smalltalk image; it replaces files and the shell. Classes, methods and workspace variables you create survive across turns and sessions.",
  "Start with inspect_world kind=overview, then browse classes and methods before changing them. Prefer adding behaviour as methods on classes in your own packages over long scripts in execute_expression.",
  "Assigning to an undeclared name in execute_expression creates a workspace variable that persists, e.g. `server := MyServer new`.",
  "The filesystem is reachable from Smalltalk: `FileLocator workingDirectory` is the project root, `(FileLocator workingDirectory / 'a.txt') contents` reads, `writeStreamDo:` writes, `LibC resultOfCommand: 'ls'` runs a shell command and answers its output.",
  "The image is saved after every definition and at the end of each turn.",
];

function imageDir(ctx: ExtensionContext): string {
  return path.join(ctx.cwd, ".pi", "smalltalk");
}

function truncate(text: string): string {
  return text.length > MAX_OUTPUT
    ? `${text.slice(0, MAX_OUTPUT)}\n… (${text.length - MAX_OUTPUT} more characters)`
    : text;
}

function withTranscript(text: string, transcript: string): string {
  return transcript ? `${text}\n\nTranscript:\n${lines(transcript)}` : text;
}

/** Answers the reply's value, or throws its error so the tool result is marked failed. */
function unwrap<T>(reply: Reply<T>, format: (value: T) => string): string {
  if (!reply.ok) {
    const { error } = reply;
    const stack = error.stack.length ? `\n${error.stack.map((frame) => `  ${lines(frame)}`).join("\n")}` : "";
    throw new Error(truncate(withTranscript(`${lines(error.description)}${stack}`, reply.transcript)));
  }
  return truncate(withTranscript(format(reply.value), reply.transcript));
}

function text(content: string) {
  return { content: [{ type: "text" as const, text: content }], details: undefined };
}

export default function (pi: ExtensionAPI) {
  let mode: Mode = { enabled: false, baselineTools: [] };
  let image: Image | undefined;

  /** The project's image, installing Pharo first if this is its first use on the machine. */
  const imageFor = async (ctx: ExtensionContext, onUpdate?: (partial: ReturnType<typeof text>) => void) => {
    const runtime = await installRuntime((message) => onUpdate?.(text(message)));
    image ??= new Image(runtime, imageDir(ctx), ctx.cwd);
    return image;
  };

  const applyMode = (ctx: ExtensionContext) => {
    if (mode.enabled) {
      pi.setActiveTools(TOOL_NAMES);
    } else {
      const active = pi.getActiveTools().filter((name) => !TOOL_NAMES.includes(name));
      pi.setActiveTools(mode.baselineTools.length ? mode.baselineTools : active);
    }
    ctx.ui.setStatus("smalltalk", mode.enabled ? "smalltalk" : undefined);
  };

  const setMode = (enabled: boolean, ctx: ExtensionContext) => {
    const baselineTools = enabled
      ? pi.getActiveTools().filter((name) => !TOOL_NAMES.includes(name))
      : mode.baselineTools;
    mode = { enabled, baselineTools };
    pi.appendEntry(MODE_ENTRY, mode);
    applyMode(ctx);
  };

  pi.registerTool({
    name: "inspect_world",
    label: "Inspect World",
    description:
      "Browse the Smalltalk image. kind=overview lists your packages and workspace variables; class shows a class " +
      "definition, comment, hierarchy and methods by protocol (name `Foo` or `Foo class`); method shows source " +
      "(name `Foo>>bar:` or `Foo class>>bar:`); package lists a package's classes; implementors and senders take a " +
      "selector; references takes a class or global name; search matches class names and selectors by substring; " +
      "object evaluates an expression and shows the resulting object's class, printString and slots.",
    promptSnippet: "Browse classes, methods, packages and objects in the live Smalltalk image",
    promptGuidelines: GUIDELINES,
    defaultActive: false,
    executionMode: "sequential",
    annotations: { readOnlyHint: true },
    parameters: Type.Object({
      kind: Type.Union([
        Type.Literal("overview"),
        Type.Literal("class"),
        Type.Literal("method"),
        Type.Literal("package"),
        Type.Literal("implementors"),
        Type.Literal("senders"),
        Type.Literal("references"),
        Type.Literal("search"),
        Type.Literal("object"),
      ]),
      name: Type.Optional(Type.String({ description: "What to inspect; not needed for overview." })),
    }),
    async execute(_id, params, signal, onUpdate, ctx) {
      const reply = await (
        await imageFor(ctx, onUpdate)
      ).call<string>("inspect", { kind: params.kind, name: params.name ?? "" }, { timeoutMs: 60_000, signal });
      return text(unwrap(reply, lines));
    },
  });

  pi.registerTool({
    name: "define_expression",
    label: "Define",
    description:
      "Define or redefine a class or method in the Smalltalk image; the image is saved afterwards. " +
      "kind=class: `source` is a fluid class definition, e.g. " +
      "`Object << #Account slots: { #balance }; tag: 'Model'; package: 'Bank'`, optionally with a `comment`; " +
      "redefining an existing class keeps its methods and migrates its instances. " +
      "kind=method: `class` names the target (`Account`, or `Account class` for the class side), `source` is the " +
      "whole method starting with its selector pattern, and `protocol` files it (e.g. `accessing`).",
    promptSnippet: "Define or redefine a class or method in the Smalltalk image",
    defaultActive: false,
    executionMode: "sequential",
    parameters: Type.Object({
      kind: Type.Union([Type.Literal("class"), Type.Literal("method")]),
      source: Type.String(),
      class: Type.Optional(Type.String({ description: "kind=method: `Foo` or `Foo class`." })),
      protocol: Type.Optional(Type.String({ description: "kind=method: protocol to file the method under." })),
      comment: Type.Optional(Type.String({ description: "kind=class: class comment." })),
    }),
    async execute(_id, params, signal, onUpdate, ctx) {
      const target = await imageFor(ctx, onUpdate);
      let reply: Reply<string>;
      if (params.kind === "class") {
        reply = await target.call<string>(
          "defineClass",
          { source: params.source, comment: params.comment },
          { timeoutMs: 30_000, signal },
        );
      } else {
        if (!params.class) throw new Error("kind=method needs `class`.");
        reply = await target.call<string>(
          "defineMethod",
          { class: params.class, source: params.source, protocol: params.protocol },
          { timeoutMs: 30_000, signal },
        );
      }
      const result = unwrap(reply, lines);
      try {
        await target.save();
        return text(result);
      } catch (e) {
        return text(`${result}\n\n${(e as Error).message}`);
      }
    },
  });

  pi.registerTool({
    name: "execute_expression",
    label: "Execute",
    description:
      "Evaluate Smalltalk statements in the image and answer the last one's class and printString, plus anything " +
      "written to Transcript. Errors come back with their stack. Undeclared names that are assigned become " +
      "workspace variables that persist. Runs are stopped after `timeoutSeconds`.",
    promptSnippet: "Evaluate Smalltalk code in the live image",
    defaultActive: false,
    executionMode: "sequential",
    parameters: Type.Object({
      code: Type.String({ description: "Smalltalk statements, separated by periods." }),
      timeoutSeconds: Type.Optional(Type.Number({ description: "Default 30, at most 600.", minimum: 1, maximum: 600 })),
    }),
    async execute(_id, params, signal, onUpdate, ctx) {
      const timeoutMs = Math.min(params.timeoutSeconds ?? 30, 600) * 1000;
      const reply = await (
        await imageFor(ctx, onUpdate)
      ).call<{ class: string; print: string }>("evaluate", { code: params.code }, { timeoutMs, signal });
      return text(unwrap(reply, (value) => `${value.class}: ${lines(value.print)}`));
    },
  });

  pi.registerCommand("smalltalk", {
    description: "Work in a persistent Smalltalk image instead of files and shell: /smalltalk [on|off|save|restart]",
    handler: async (args, ctx) => {
      const arg = args.trim();
      if (arg === "save") {
        if (!image?.running) return void ctx.ui.notify("The image is not running.", "info");
        await image.save();
        return void ctx.ui.notify("Image saved.", "info");
      }
      if (arg === "restart") {
        await image?.stop(false);
        return void ctx.ui.notify("Image stopped without saving; it restarts from its last save.", "info");
      }
      if (arg && arg !== "on" && arg !== "off") {
        return void ctx.ui.notify("Usage: /smalltalk [on|off|save|restart]", "warning");
      }
      const enabled = arg ? arg === "on" : !mode.enabled;
      if (enabled && !installedRuntime()) {
        ctx.ui.notify("Installing Pharo 13 (about 100 MB, once)…", "info");
        try {
          await installRuntime((message) => ctx.ui.notify(message, "info"));
        } catch (e) {
          return void ctx.ui.notify(`Could not install Pharo: ${(e as Error).message}`, "error");
        }
      }
      if (!enabled) await image?.stop(true);
      setMode(enabled, ctx);
      ctx.ui.notify(
        enabled ? `Smalltalk mode on. The image lives in ${imageDir(ctx)}.` : "Smalltalk mode off; image saved.",
        "info",
      );
    },
  });

  pi.registerFlag("smalltalk", { type: "boolean", description: "Start in Smalltalk mode (see /smalltalk)" });

  pi.on("session_start", async (_event, ctx) => {
    let restored: Mode | undefined;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "custom" && entry.customType === MODE_ENTRY) restored = entry.data as Mode;
    }
    if (pi.getFlag("smalltalk") && !restored?.enabled) return setMode(true, ctx);
    if (!restored) return;
    mode = restored;
    applyMode(ctx);
  });

  // Extensions that register tools late activate them, so the mode is reasserted before every run.
  pi.on("before_agent_start", async () => {
    if (mode.enabled) pi.setActiveTools(TOOL_NAMES);
  });

  pi.on("agent_end", async (_event, ctx) => {
    try {
      await image?.saveIfDirty();
    } catch (e) {
      ctx.ui.notify(`Could not save the Smalltalk image: ${(e as Error).message}`, "warning");
    }
  });

  pi.on("session_shutdown", async () => {
    const closing = image;
    image = undefined;
    await closing?.stop(true);
  });
}
