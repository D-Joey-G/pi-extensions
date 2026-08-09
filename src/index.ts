import {
  createLocalBashOperations,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { isCadence } from "./config.js";
import { PairController } from "./controller.js";
import { renderNotes } from "./prompts.js";
import { isReadOnlyCommand, MUTATING_TOOLS } from "./roles.js";
import { registerPairTools } from "./tools.js";
import type { Cadence } from "./types.js";

const IDLE_TICK_MS = 60_000;
/** Tail of a failed command's output to show the navigator. */
const FAILURE_OUTPUT_CHARS = 2000;

export default function pairCoding(pi: ExtensionAPI) {
  const controller = new PairController(pi);
  let idleTimer: NodeJS.Timeout | undefined;

  registerPairTools(pi, {
    // The gap clock starts when the navigator speaks, not when it looks.
    onInterject: (_kind, _message, ctx) => controller.noteInterjection(remember(ctx)),
    onStayQuiet: () => {},
    onNote: (note, ctx) => controller.addNote(note, remember(ctx)),
  });

  // Kept for the shutdown path, which has no ctx of its own.
  let lastCtx: ExtensionContext | undefined;
  const remember = (ctx: ExtensionContext) => {
    lastCtx = ctx;
    return ctx;
  };

  pi.on("session_start", (_event, ctx) => {
    remember(ctx);
    controller.restore(ctx);
    controller.updateUi(ctx);
  });

  pi.on("session_shutdown", async () => {
    if (idleTimer) clearInterval(idleTimer);
    idleTimer = undefined;
    await controller.stop(lastCtx);
  });

  // Give the navigator its role instructions on every turn, and keep the
  // pairing record in front of it so it argues from what was decided.
  pi.on("before_agent_start", (event, ctx) => {
    remember(ctx);
    const suffix = controller.systemPromptSuffix();
    if (!suffix) return;
    return { systemPrompt: `${event.systemPrompt}\n\n${suffix}` };
  });

  // Belt and braces: even if the tool set drifts, the navigator cannot write.
  pi.on("tool_call", async (event, ctx) => {
    remember(ctx);
    if (!controller.isActive || controller.currentRole !== "navigator") return;

    if (MUTATING_TOOLS.includes(event.toolName)) {
      return {
        block: true,
        reason:
          "You are the navigator — the driver edits the files. Say what you would change and why, or use /pair drive to ask for the keyboard.",
      };
    }

    if (event.toolName === "bash") {
      const command = String((event.input as { command?: unknown } | undefined)?.command ?? "");
      if (isReadOnlyCommand(command)) return;
      if (controller.isMuted || !ctx.hasUI) {
        return { block: true, reason: "Navigator mode allows read-only shell commands only." };
      }
      const ok = await ctx.ui.confirm("Navigator wants to run a command", command);
      if (!ok) return { block: true, reason: "Driver declined the command." };
    }
  });

  // A failing command is the one moment a navigator should always lean in.
  // Wrapping pi's own bash backend gives us the exit code and output directly,
  // rather than guessing at them from the transcript after the fact.
  pi.on("user_bash", (_event, ctx) => {
    remember(ctx);
    if (!controller.isActive) return;
    const local = createLocalBashOperations();
    return {
      operations: {
        async exec(command, cwd, options) {
          const chunks: Buffer[] = [];
          const result = await local.exec(command, cwd, {
            ...options,
            onData: (data) => {
              chunks.push(data);
              options.onData(data);
            },
          });
          if (result.exitCode !== null && result.exitCode !== 0) {
            const output = Buffer.concat(chunks).toString("utf8").slice(-FAILURE_OUTPUT_CHARS);
            void controller.reportFailedCommand(command, result.exitCode, output, ctx);
          }
          return result;
        },
      },
    };
  });

  pi.registerCommand("pair", {
    description: "Pair-coding mode: you drive, the agent navigates (on|off|quiet|normal|chatty|look|notes|mute|status)",
    getArgumentCompletions: (prefix: string) => {
      const subcommands = [
        "on",
        "off",
        "quiet",
        "normal",
        "chatty",
        "look",
        "notes",
        "mute",
        "unmute",
        "status",
        "drive",
        "navigate",
      ];
      const items = subcommands.filter((s) => s.startsWith(prefix)).map((s) => ({ value: s, label: s }));
      return items.length > 0 ? items : null;
    },
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      remember(ctx);
      const [sub = "", ...rest] = args.trim().split(/\s+/);
      const remainder = rest.join(" ");

      switch (sub) {
        case "":
        case "on": {
          // `/pair on chatty` starts straight into a cadence.
          const cadence: Cadence = isCadence(remainder) ? remainder : "normal";
          if (controller.isActive) {
            controller.setCadence(cadence, ctx);
            ctx.ui.notify(`Pair mode already on — cadence ${cadence}.`, "info");
            return;
          }
          await controller.start(ctx, cadence);
          ctx.ui.notify(`Pair mode on (${cadence}) — you have the keyboard. I'll watch and chime in.`, "info");
          startIdleLoop(ctx);
          return;
        }

        case "off":
          await controller.stop(ctx);
          stopIdleLoop();
          ctx.ui.notify("Pair mode off. Tools restored.", "info");
          return;

        case "quiet":
        case "normal":
        case "chatty": {
          const cadence: Cadence = sub;
          if (!controller.isActive) await controller.start(ctx, cadence);
          else controller.setCadence(cadence, ctx);
          ctx.ui.notify(`Cadence: ${cadence}.`, "info");
          startIdleLoop(ctx);
          return;
        }

        case "look":
          if (!requireActive(ctx)) return;
          await controller.lookNow(ctx, remainder || undefined);
          return;

        case "notes":
          ctx.ui.notify(renderNotes([...controller.sessionNotes]), "info");
          return;

        case "mute":
          if (!requireActive(ctx)) return;
          controller.setMuted(true, ctx);
          ctx.ui.notify("Muted. I'll keep watching but stay out of your way.", "info");
          return;

        case "unmute":
          if (!requireActive(ctx)) return;
          controller.setMuted(false, ctx);
          ctx.ui.notify("Unmuted.", "info");
          return;

        case "drive": {
          if (!requireActive(ctx)) return;
          if (!remainder) {
            ctx.ui.notify("Say what to hand over, e.g. /pair drive extract the retry logic into a helper", "warning");
            return;
          }
          controller.setRole("driver", ctx);
          ctx.ui.notify("You have the keyboard — handing over.", "info");
          pi.sendUserMessage(`Taking the keyboard for this task only: ${remainder}`);
          return;
        }

        case "navigate":
          if (!requireActive(ctx)) return;
          controller.setRole("navigator", ctx);
          ctx.ui.notify("Keyboard back to you. I'm navigating again.", "info");
          return;

        case "status":
          ctx.ui.notify(
            controller.isActive
              ? `pair: ${controller.currentRole} · ${controller.currentCadence}${controller.isMuted ? " · muted" : ""} · ${controller.sessionNotes.length} note(s)`
              : "pair: off",
            "info",
          );
          return;

        default:
          ctx.ui.notify(
            `Unknown: /pair ${sub}. Try on, off, quiet, normal, chatty, look, notes, mute, drive, navigate, status.`,
            "warning",
          );
      }
    },
  });

  function requireActive(ctx: ExtensionContext): boolean {
    if (controller.isActive) return true;
    ctx.ui.notify("Pair mode is off. Start it with /pair on.", "warning");
    return false;
  }

  function startIdleLoop(ctx: ExtensionContext): void {
    if (idleTimer) return;
    idleTimer = setInterval(() => {
      void controller.maybeNudge(ctx);
    }, IDLE_TICK_MS);
    idleTimer.unref?.();
  }

  function stopIdleLoop(): void {
    if (idleTimer) clearInterval(idleTimer);
    idleTimer = undefined;
  }

  // pi claims every ctrl+<letter>, so this has to live under alt. Terminals
  // that send Option as a literal character rather than Meta will not deliver
  // it; `/pair look` is the portable path.
  pi.registerShortcut("alt+g", {
    description: "Ask the navigator what it thinks right now",
    handler: async (ctx) => {
      remember(ctx);
      if (!controller.isActive) {
        ctx.ui.notify("Pair mode is off. Start it with /pair on.", "warning");
        return;
      }
      await controller.lookNow(ctx);
    },
  });
}
