import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { PairNote } from "./types.js";

export interface ToolHooks {
  isActive: () => boolean;
  onInterject: (kind: InterjectKind, message: string, ctx: ExtensionContext) => void;
  /** `reason` is the model's own one-liner; it is visible when the tool row is expanded. */
  onStayQuiet: (reason: string | undefined, ctx: ExtensionContext) => void;
  onNote: (note: PairNote, ctx: ExtensionContext) => void;
  onRequestDrive: (
    request: { task: string; files: string[] },
    ctx: ExtensionContext,
  ) => Promise<{ approved: boolean; reason: string }>;
}

export type InterjectKind = "question" | "suggestion" | "concern" | "observation";

const KIND_PREFIX: Record<InterjectKind, string> = {
  question: "?",
  suggestion: "~",
  concern: "!",
  observation: "·",
};

export function registerPairTools(pi: ExtensionAPI, hooks: ToolHooks): void {
  pi.registerTool({
    name: "interject",
    label: "Navigator",
    description:
      "Say something to the driver. Use only when the remark is worth interrupting their flow for. " +
      "One point, phrased as you would say it out loud to someone sitting next to you.",
    promptSnippet: "interject — speak up to the driver with a question, suggestion, or concern.",
    renderShell: "self",
    parameters: Type.Object({
      kind: Type.Union(
        [Type.Literal("question"), Type.Literal("suggestion"), Type.Literal("concern"), Type.Literal("observation")],
        {
          description:
            "question: asking them something. suggestion: proposing a direction. concern: flagging a risk. observation: neutral noticing.",
        },
      ),
      message: Type.String({
        description: "What you want to say. Conversational, one point, no preamble. Two or three sentences at most.",
      }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!hooks.isActive()) throw new Error("Pair mode is off. Start it with /pair on.");
      hooks.onInterject(params.kind, params.message, ctx);
      const prefix = KIND_PREFIX[params.kind];
      return {
        content: [{ type: "text" as const, text: `${prefix} ${params.message}` }],
        details: { kind: params.kind },
      };
    },
    renderCall(args, theme) {
      const prefix = KIND_PREFIX[args.kind];
      const color =
        args.kind === "concern"
          ? "warning"
          : args.kind === "suggestion"
            ? "success"
            : args.kind === "observation"
              ? "muted"
              : "accent";
      return new Text(`${theme.fg(color, prefix)} ${args.message}`, 0, 0);
    },
    renderResult(result, _options, theme, context) {
      return renderEmptyResult(result, theme, context.isError);
    },
  });

  pi.registerTool({
    name: "stay_quiet",
    label: "Navigator (quiet)",
    description:
      "Say nothing. The correct choice most of the time: the change is fine, or your point can wait until the driver surfaces. " +
      "Preferring this over a marginal interjection is what makes you a good pair rather than a nuisance.",
    promptSnippet: "stay_quiet — decline to interrupt; the default when watching a diff.",
    renderShell: "self",
    parameters: Type.Object({
      reason: Type.Optional(
        Type.String({
          description: "One short line for your own record of why this did not need a remark. Not shown prominently.",
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!hooks.isActive()) throw new Error("Pair mode is off. Start it with /pair on.");
      hooks.onStayQuiet(params.reason, ctx);
      return {
        content: [{ type: "text" as const, text: params.reason ?? "nothing to add" }],
        details: {},
      };
    },
    renderCall(args, theme, context) {
      let text = theme.fg("dim", "· navigator · quiet");
      if (context.expanded && args.reason) text += `\n  ${theme.fg("muted", args.reason)}`;
      return new Text(text, 0, 0);
    },
    renderResult(result, _options, theme, context) {
      return renderEmptyResult(result, theme, context.isError);
    },
  });

  pi.registerTool({
    name: "request_drive",
    label: "Request keyboard",
    description:
      "Ask the human to hand you the keyboard for one scoped implementation task. " +
      "Use this only when doing the edit yourself is materially more useful than explaining it. The human must approve.",
    promptSnippet: "request_drive — ask permission to take the keyboard for one scoped task.",
    renderShell: "self",
    parameters: Type.Object({
      task: Type.String({ description: "A concise description of the implementation you want permission to perform." }),
      files: Type.Optional(
        Type.Array(Type.String(), { description: "Files you expect to change, if known.", maxItems: 12 }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!hooks.isActive()) throw new Error("Pair mode is off. Start it with /pair on.");
      const decision = await hooks.onRequestDrive({ task: params.task, files: params.files ?? [] }, ctx);
      return {
        content: [{ type: "text" as const, text: decision.reason }],
        details: { approved: decision.approved, files: params.files ?? [] },
        // Approval queues a fresh driver turn with the correct role prompt.
        terminate: decision.approved,
      };
    },
    renderCall(args, theme, context) {
      let text = `${theme.fg("accent", "⇄")} ${theme.fg("toolTitle", "keyboard request")} · ${args.task}`;
      if (context.expanded && args.files?.length) text += `\n  ${theme.fg("muted", args.files.join(", "))}`;
      return new Text(text, 0, 0);
    },
    renderResult(result, _options, theme, context) {
      if (context.isError) return renderEmptyResult(result, theme, true);
      const approved = (result.details as { approved?: boolean } | undefined)?.approved;
      return new Text(theme.fg(approved ? "success" : "muted", approved ? "  approved" : "  not approved"), 0, 0);
    },
  });

  pi.registerTool({
    name: "pair_note",
    label: "Pair note",
    description:
      "Record a decision the driver made, an open question, or a risk, so it survives the rest of the session. " +
      "Use it when something is settled or deliberately deferred — not as a running commentary.",
    promptSnippet: "pair_note — record a decision, open question, or risk for the session record.",
    renderShell: "self",
    parameters: Type.Object({
      kind: Type.Union([Type.Literal("decision"), Type.Literal("question"), Type.Literal("risk")]),
      text: Type.String({ description: "One line. State the substance, not the conversation around it." }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!hooks.isActive()) throw new Error("Pair mode is off. Start it with /pair on.");
      const note: PairNote = { kind: params.kind, text: params.text, at: Date.now() };
      hooks.onNote(note, ctx);
      return {
        content: [{ type: "text" as const, text: `recorded ${params.kind}: ${params.text}` }],
        details: { kind: params.kind },
      };
    },
    renderCall(args, theme) {
      const prefix = theme.fg("muted", "◆ pair · ");
      return new Text(`${prefix}${theme.fg("accent", args.kind)} · ${args.text}`, 0, 0);
    },
    renderResult(result, _options, theme, context) {
      return renderEmptyResult(result, theme, context.isError);
    },
  });
}

function renderEmptyResult(
  result: { content: Array<{ type: string; text?: string }> },
  theme: Theme,
  isError: boolean,
): Container | Text {
  if (!isError) return new Container();
  const first = result.content[0];
  const message = first?.type === "text" ? first.text : "Pair tool failed";
  return new Text(theme.fg("error", message ?? "Pair tool failed"), 0, 0);
}
