import {
  createLocalBashOperations,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { isCadence, OVERRIDABLE_KEYS, parseOverride, renderConfig } from "./config.js";
import { PairController } from "./controller.js";
import { renderNotes } from "./prompts.js";
import { disablePairTools, isAllowedTool } from "./roles.js";
import { registerPairTools } from "./tools.js";
import type { Cadence } from "./types.js";

const IDLE_TICK_MS = 60_000;
/** Tail of a failed command's output to show the navigator. */
const FAILURE_OUTPUT_CHARS = 2000;

const SUBCOMMANDS = [
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
  "config",
  "set",
  "drive",
  "navigate",
] as const;

export default function pairCoding(pi: ExtensionAPI) {
  let idleTimer: NodeJS.Timeout | undefined;

  // Kept for the shutdown path, which has no ctx of its own.
  let lastCtx: ExtensionContext | undefined;
  const remember = <T extends ExtensionContext>(ctx: T): T => {
    lastCtx = ctx;
    return ctx;
  };

  const controller = new PairController(pi, {
    onWatcherError: (error, ctx) => {
      stopIdleLoop();
      if (ctx.hasUI) ctx.ui.notify(`Pair mode stopped — the file watcher failed: ${error.message}`, "error");
    },
  });

  registerPairTools(pi, {
    isActive: () => controller.isActive,
    // The gap clock starts when the navigator speaks, not when it looks.
    onInterject: (_kind, _message, ctx) => controller.noteInterjection(remember(ctx)),
    onStayQuiet: (reason, ctx) => controller.noteQuiet(reason, remember(ctx)),
    onNote: (note, ctx) => controller.addNote(note, remember(ctx)),
    onRequestDrive: async ({ task, files }, ctx) => {
      remember(ctx);
      if (controller.currentRole !== "navigator") {
        return { approved: false, reason: "You already have the keyboard." };
      }
      if (controller.isMuted) {
        return { approved: false, reason: "The navigator is muted, so keyboard requests are refused." };
      }
      if (!ctx.hasUI) {
        return { approved: false, reason: "No interactive UI is available to approve the keyboard request." };
      }

      const scope =
        files.length > 0 ? `${task}\n\nExpected files:\n${files.map((file) => `• ${file}`).join("\n")}` : task;
      const approved = await ctx.ui.confirm("Navigator requests the keyboard", scope);
      if (!approved) return { approved: false, reason: "The driver declined the keyboard request." };

      controller.setRole("driver", ctx, { returnAfterSettled: true });
      pi.sendUserMessage(`Keyboard granted for this scoped task: ${task}`, { deliverAs: "followUp" });
      return { approved: true, reason: `Keyboard granted for this scoped task: ${task}` };
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    remember(ctx);
    await controller.restore(ctx);
    // Pairing may have been on when the session ended, in which case restore
    // brought the watcher back up and the idle loop has to come with it.
    if (controller.isActive) startIdleLoop(ctx);
    else disablePairTools(pi);
    controller.updateUi(ctx);
  });

  pi.on("session_shutdown", async () => {
    stopIdleLoop();
    // Cleanup must not turn an active session off in its transcript: reload and
    // resume construct a fresh controller that restores this choice.
    await controller.dispose(lastCtx);
  });

  // The navigator's turn is over, so the next burst may be shown.
  pi.on("agent_settled", (_event, ctx) => {
    remember(ctx);
    if (controller.noteAgentSettled(ctx) && ctx.hasUI) {
      ctx.ui.notify("Scoped task settled. Keyboard returned to you.", "info");
    }
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
    const config = controller.currentConfig;

    if (!isAllowedTool(event.toolName, config.extraReadOnlyTools)) {
      return {
        block: true,
        reason:
          `You are the navigator — \`${event.toolName}\` is not on the read-only list. ` +
          "Explain what you would change, or call request_drive to ask for the keyboard. " +
          `If this tool only reads, the driver can allow it with: /pair set extraReadOnlyTools ${event.toolName}`,
      };
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
          let outputTail = Buffer.alloc(0);
          const result = await local.exec(command, cwd, {
            ...options,
            onData: (data) => {
              outputTail = Buffer.concat([outputTail, data]).subarray(-FAILURE_OUTPUT_CHARS * 4);
              options.onData(data);
            },
          });
          if (result.exitCode !== null && result.exitCode !== 0) {
            const output = outputTail.toString("utf8").slice(-FAILURE_OUTPUT_CHARS);
            void controller.reportFailedCommand(command, result.exitCode, output, ctx);
          }
          return result;
        },
      },
    };
  });

  pi.registerCommand("pair", {
    description: `Pair-coding mode: you drive, the agent navigates (${SUBCOMMANDS.join("|")})`,
    getArgumentCompletions: (prefix: string) => {
      const setMatch = prefix.match(/^set\s+(\S*)$/);
      if (setMatch) {
        const partial = setMatch[1] ?? "";
        const items = OVERRIDABLE_KEYS.filter((key) => key.startsWith(partial)).map((key) => ({
          value: `set ${key}`,
          label: key,
        }));
        return items.length > 0 ? items : null;
      }
      const onMatch = prefix.match(/^on\s+(\S*)$/);
      if (onMatch) {
        const partial = onMatch[1] ?? "";
        const items = (["quiet", "normal", "chatty"] as const)
          .filter((cadence) => cadence.startsWith(partial))
          .map((cadence) => ({ value: `on ${cadence}`, label: cadence }));
        return items.length > 0 ? items : null;
      }
      const items = SUBCOMMANDS.filter((s) => s.startsWith(prefix)).map((s) => ({ value: s, label: s }));
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
          let cadence: Cadence = "normal";
          if (remainder) {
            if (!isCadence(remainder)) {
              ctx.ui.notify(`Unknown cadence "${remainder}". Use quiet, normal, or chatty.`, "warning");
              return;
            }
            cadence = remainder;
          }
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

        case "look": {
          if (!requireActive(ctx)) return;
          const decision = await controller.lookNow(ctx, remainder || undefined);
          // Silence here would look like the shortcut simply did nothing.
          if (!decision.observe) ctx.ui.notify(`Not looking right now — ${decision.reason}.`, "warning");
          return;
        }

        case "notes":
          ctx.ui.notify(renderNotes([...controller.sessionNotes]), "info");
          return;

        case "mute":
          if (!requireActive(ctx)) return;
          controller.setMuted(true, ctx);
          ctx.ui.notify("Muted. I'll keep watching but stay out of your way — /pair look still works.", "info");
          return;

        case "unmute":
          if (!requireActive(ctx)) return;
          controller.setMuted(false, ctx);
          ctx.ui.notify("Unmuted.", "info");
          return;

        case "config":
          ctx.ui.notify(renderConfig(controller.currentConfig), "info");
          return;

        case "set": {
          const [key = "", ...valueParts] = rest;
          if (!key) {
            ctx.ui.notify(`Usage: /pair set <key> <value>. Keys: ${OVERRIDABLE_KEYS.join(", ")}.`, "warning");
            return;
          }
          const parsed = parseOverride(key, valueParts.join(" "));
          if (!parsed.ok) {
            ctx.ui.notify(parsed.error, "warning");
            return;
          }
          await controller.setOverrides(parsed.override, ctx);
          ctx.ui.notify(`${key} = ${valueParts.join(" ").trim()}`, "info");
          return;
        }

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
          ctx.ui.notify(`Unknown: /pair ${sub}. Try ${SUBCOMMANDS.join(", ")}.`, "warning");
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
      const decision = await controller.lookNow(ctx);
      if (!decision.observe) ctx.ui.notify(`Not looking right now — ${decision.reason}.`, "warning");
    },
  });
}
