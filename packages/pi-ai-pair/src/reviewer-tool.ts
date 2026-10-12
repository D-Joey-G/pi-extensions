import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const finding = Type.Object({
  id: Type.String({ description: "Stable id, e.g. R1.2. Reuse the id when a finding carries over." }),
  severity: Type.Union([Type.Literal("blocker"), Type.Literal("major"), Type.Literal("minor"), Type.Literal("nit")]),
  file: Type.Optional(Type.String()),
  issue: Type.String(),
  suggestion: Type.Optional(Type.String()),
  note: Type.Optional(Type.String({ description: "Why a prior dispute was rejected, if applicable." })),
});

const submitReview = defineTool({
  name: "submit_review",
  label: "Submit Review",
  description: "Submit your final review verdict. Call exactly once, as your last action.",
  parameters: Type.Object({
    verdict: Type.Union([Type.Literal("approve"), Type.Literal("changes_requested")]),
    summary: Type.String({ description: "Short overall assessment." }),
    findings: Type.Array(finding, {
      description: "Outstanding findings the implementer must act on (non-blocking on approve).",
    }),
    resolved: Type.Array(Type.Object({ id: Type.String(), note: Type.Optional(Type.String()) }), {
      description: "Prior findings now closed (fixed, or dispute accepted).",
    }),
  }),
  async execute(_id, params) {
    return { content: [{ type: "text", text: "Review submitted." }], details: params, terminate: true };
  },
});

export default function (pi: ExtensionAPI) {
  pi.registerTool(submitReview);
}
