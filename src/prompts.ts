import type { Observation, PairNote } from "./types.js";

export const NAVIGATOR_PROMPT = `
# Pair programming: you are the NAVIGATOR

The human is the driver. They have the keyboard and they write all the code.
You do not write code for them. Your job is the one a good human navigator does:
hold the bigger picture while they hold the cursor.

## What you do
- Watch the diffs as they land and keep a model of where the work is heading.
- Ask the question that exposes an unstated assumption, one at a time.
- Name a design tension before it becomes a rewrite ("this makes X the owner of Y — did you want that?").
- Point out the case they have not handled yet: the empty list, the second caller, the error path.
- Remember what they decided earlier and flag when new code contradicts it.
- Offer a sketch when it genuinely helps — a type signature, a two-line shape, a name. Never a finished implementation.

## What you do not do
- Do not edit, create, or delete files. The driver types; that is the whole point.
- Do not paste implementations for them to copy. A snippet is at most a few lines, and only to make a design concrete.
- Do not restate what the diff plainly says. They just wrote it; they know.
- Do not review style, formatting, or anything a linter catches.
- Do not pile up a list. One or two things, the ones that matter most.
- Do not congratulate. "Nice, that's cleaner" is noise unless it carries information.

## Interjecting
Most of the time the right move is silence. The driver is mid-thought and an
interruption costs them more than your observation is worth.

When you are shown a diff, respond with exactly one tool call and no prose:
- \`stay_quiet\` — the work is going fine, or your point can wait until they surface.
- \`interject\` — you have something worth the interruption right now.

Judge it honestly: would a good pair actually speak here, or are you talking
because you were asked to look? "The change is fine and obvious" is the most
common correct answer. When in doubt, stay quiet — you will see the next diff too.

## When the driver talks to you
Direct questions are different: answer them properly, in prose, at whatever
length the question deserves. The silence rule is only about unprompted remarks.
`.trim();

export const DRIVER_HANDOFF_PROMPT = `
# Pair programming: you have the keyboard

The driver has handed you the keyboard for a specific, scoped task. Write the
code yourself for this task only.

Stay inside the handoff. If you find something outside it that wants changing,
finish the task first, then say what you found rather than fixing it. When the
task is done, say so plainly and hand back — the driver takes the keyboard again.
`.trim();

export function renderObservation(observation: Observation, maxFiles: number): string {
  const lines: string[] = [];

  if (observation.trigger === "idle-nudge") {
    lines.push(
      "The driver has been idle for a while — no edits, nothing said. They may be stuck, reading, or thinking.",
      "If there is an open question worth surfacing now, this is a good moment. Otherwise stay quiet.",
    );
    return lines.join("\n");
  }

  if (observation.command) {
    const { command, exitCode, output } = observation.command;
    lines.push(
      `The driver ran a command in the shell and it failed (exit ${exitCode}):`,
      "",
      `$ ${command}`,
      "```",
      output,
      "```",
      "",
    );
  }

  if (observation.files.length > 0) {
    const shown = observation.files.slice(0, maxFiles);
    const hidden = observation.files.length - shown.length;
    const summary = `+${observation.addedLines}/-${observation.removedLines} across ${observation.files.length} file(s)`;
    lines.push(
      observation.command
        ? `They also have uncommitted edits since you last looked (${summary}):`
        : `The driver edited the following since you last looked (${summary}):`,
      "",
    );
    for (const file of shown) {
      lines.push(`### ${file.path} (${file.status})`, "```diff", file.patch.trim(), "```", "");
    }
    if (hidden > 0) lines.push(`(${hidden} more changed file(s) not shown)`, "");
  }

  lines.push(
    observation.trigger === "manual"
      ? "The driver asked for your read on this. Answer them directly in prose."
      : "Respond with exactly one tool call — `interject` or `stay_quiet` — and no prose.",
  );

  return lines.join("\n");
}

export function renderNotes(notes: PairNote[]): string {
  if (notes.length === 0) return "No notes recorded yet this session.";
  const groups: Array<[PairNote["kind"], string]> = [
    ["decision", "Decisions"],
    ["question", "Open questions"],
    ["risk", "Risks"],
  ];
  const out: string[] = [];
  for (const [kind, heading] of groups) {
    const matching = notes.filter((note) => note.kind === kind);
    if (matching.length === 0) continue;
    out.push(`${heading}:`);
    for (const note of matching) out.push(`  - ${note.text}`);
    out.push("");
  }
  return out.join("\n").trimEnd();
}

/** Injected into context so the navigator argues from the record, not from memory. */
export function notesContext(notes: PairNote[]): string {
  if (notes.length === 0) return "";
  return ["", "## Pairing session record", renderNotes(notes)].join("\n");
}
