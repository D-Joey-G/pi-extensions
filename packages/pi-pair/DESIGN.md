# Pair coding in pi: extension, not fork

## The recommendation

**Build it as a pi extension.** I looked at forking pi to invert the driver/navigator
relationship in core, and it isn't warranted. Every mechanism the idea needs is
already exposed to extensions, and pi is moving fast enough (0.84.1 as of writing,
with `@earendil-works/pi-coding-agent` publishing frequently) that a fork would
spend most of its life merging.

Concretely, the extension API already gives us:

| What pair coding needs | pi already exposes |
| --- | --- |
| Take away the agent's ability to edit | `pi.setActiveTools()`, plus `tool_call` → `{ block: true }` |
| Give the agent a different personality | `before_agent_start` → `{ systemPrompt }` |
| Let the agent speak without a user prompt | `pi.sendMessage(..., { triggerTurn: true })` |
| Show the agent what the human just did | `pi.exec()` + a file watcher; nothing upstream needed |
| Structured "speak or stay silent" output | `pi.registerTool()` with custom rendering |
| Notice when the human's own command fails | `user_bash` → wrap `createLocalBashOperations()` |
| Persist decisions across restarts | `pi.appendEntry()` + `sessionManager.getBranch()` |
| Status line and widget | `ctx.ui.setStatus()` / `ctx.ui.setWidget()` |

`pi-review`, `pi-review-loop`, and `pi-tutorial` are all precedents for extensions
that substantially change how a session behaves without touching core.

## The inversion

Normal pi: **the agent edits, the human reviews.** The human's attention is spent
reading generated code and deciding whether to accept it.

Pair mode: **the human edits, the agent watches.** The human keeps the cursor, the
muscle memory, and the mental model of the code. The agent supplies the thing a
solo programmer actually lacks — a second person holding the bigger picture, who
notices the unhandled case and asks the question that exposes the wrong
assumption.

That inversion is not a prompt change. Three things have to be true:

1. **The agent genuinely cannot edit.** Not "is asked not to" — cannot. Otherwise
   the first time the human hesitates, the agent fills the silence with a patch
   and the session collapses back into normal pi.
2. **The agent sees the work as it happens.** A navigator who only knows what you
   tell them is a rubber duck. The diff has to arrive on its own.
3. **The agent is quiet by default.** This is the hard part, and it is where most
   of the design effort went.

## The interruption problem

An agent that comments on every save is worse than no agent. Flow state is the
thing pair programming is supposed to protect, and an LLM given a diff will
always find something to say — that is what it is trained to do.

Two mechanisms, deliberately separate:

**Mechanical pacing** (`src/policy.ts`) decides whether to *look*. It is a pure
function over the burst and the session's history, which is why it is the most
heavily tested part of the codebase. The two clocks are asymmetric on purpose:

- `minGapMs` runs from the last time the navigator **spoke**. A run of "nothing
  to say" looks does not buy it the right to interrupt sooner.
- `maxObservationsPerHour` counts every look, because every look is a model
  request the user pays for.

Small bursts below `minChangedLines` aren't discarded — they merge into the next
one (`mergeObservations`), so three small related edits eventually add up to one
observation instead of vanishing. Once a merged burst is shown, the baseline
advances for every file in it, not just the ones from the burst that tripped the
threshold — otherwise the lines that rode along would show up again next time
and the navigator would repeat itself.

There is a third clock that isn't in `policy.ts`, because it isn't about pacing:
the navigator never starts a second look while the first is still in flight
(`busyReason`). Queuing observations behind an unanswered one interrupts the
navigator rather than the driver, and arrives as a stale remark about code that
has since moved. The flag is cleared by `agent_settled` rather than at send
time — the send returns immediately and the turn runs after it. A direct
`/pair look` is exempt: the driver asked, so the driver owns the timing.

**Editorial judgement** decides whether to *speak*. When the navigator is shown a
diff, it must answer with exactly one tool call: `interject` or `stay_quiet`. The
choice is forced into the tool layer rather than left to prose, which means:

- silence is a first-class, cheap, explicitly-modelled outcome rather than
  something the model has to be nagged into;
- the extension knows whether the navigator spoke, so the gap clock is accurate;
- `stay_quiet` renders as almost nothing in the TUI.

The `stay_quiet` tool description does real work here. It tells the model that
preferring silence is what makes it a good pair rather than a nuisance, which is
a better lever than any amount of "be concise" in the system prompt.

## Role handoff

Real pairs swap. `/pair drive <task>` gives the agent the keyboard for one scoped
task and switches it to `DRIVER_HANDOFF_PROMPT`; `/pair navigate` takes it back.
The navigator can also call `request_drive` with a task and expected files. If the
driver approves the dialog, a fresh follow-up turn starts with the driver prompt
and the keyboard returns automatically when that run settles. The tool baseline
captured at `/pair on` is restored exactly, so swapping does not quietly change
the driver's own tool configuration.

While the agent is driving, the watcher stops feeding it observations — otherwise
it would be reacting to its own diffs, which is a feedback loop rather than a
pairing session. Its writes still land in the snapshot baseline, so taking the
keyboard back doesn't dump everything the agent just wrote onto the navigator as
though the driver had typed it.

## Guarding the invariant

Navigator mode trims the active tool set *and* blocks at `tool_call`, because the
active tool set can be changed by other extensions or by the user mid-session,
and the invariant should not depend on that.

Both gates are an **allowlist** (`READ_ONLY_TOOLS`), which is the part worth
arguing about. A denylist of known writers — `write`, `edit`, `apply_patch` — is
friendlier, and it was the first thing I wrote. It cannot deliver the promise
above. The invariant is "cannot edit", and a denylist is only as good as its
authors' knowledge of every tool that will ever be in the session: a tool pi adds
next release, an MCP server the driver connects, another extension's helper. Each
of those passes a denylist by default. Inverting it means the unknown case fails
closed, which is the only version that matches what the mode claims to be.

The cost is real and lands on MCP: a read-only `get_issue` tool is refused
alongside a `create_pr` one, because nothing in the name distinguishes them.
`extraReadOnlyTools` is the escape hatch, and the block message names it so the
navigator can tell the driver what to run rather than just failing.

`bash` is excluded outright. That means the navigator cannot inspect Git history
or run tests through an arbitrary shell, but it removes a command-classification
heuristic that could never provide the same guarantee as the tool allowlist. If
shell work is materially useful, the navigator requests a scoped keyboard handoff.
Narrow read-only tools can be added explicitly through `extraReadOnlyTools`.

## Mute is not silence

`mute` suppresses everything the navigator would have volunteered — edit bursts,
idle nudges, and the failed-command lean-in. It deliberately does not suppress
`/pair look`, because that is the driver asking a question, and a mode where
pressing the key does nothing at all reads as a broken shortcut rather than a
respected preference. A `request_drive` call is refused while muted because its
confirmation dialog would be a way of talking to someone who asked not to be
talked to.

## Surviving a restart

State goes into the session transcript as custom entries (`pi/appendEntry`) and
comes back on `session_start`. Notes always return. The rest — cadence, role,
mute, `/pair set` overrides, and the captured tool baseline — only matters when
pairing was on when the session ended, and in that case the watcher and tool set
are brought back up with it.

Restoring the label without the machinery was the tempting shortcut and is worse
than not restoring at all: the widget claims to be watching a tree that nothing
is watching, and the driver finds out when the first hour of work goes
unremarked. Either the session is restored or it isn't.

## What would need upstream changes

Two things I could not do cleanly from an extension:

1. **Suppressing assistant prose.** The observation prompt says "respond with
   exactly one tool call and no prose", but pi streams assistant text as it
   arrives. A model that emits a preamble before calling `stay_quiet` will show
   that preamble, which is exactly the interruption the mechanism exists to
   prevent. A `message_end` result that could drop the text of a turn, or an
   "invisible turn" mode, would close this. In practice the instruction holds
   well enough with current models, but it is advisory.

2. **A cheaper triage model.** Every observation costs a request on the session's
   main model, which is why the hourly budget exists at all. Extensions can call
   `pi.setModel()`, but not run a single side query against a small model without
   disturbing the session. A `pi.complete(prompt, { model })` escape hatch would
   let the silence/speak decision run on something cheap and reserve the main
   model for when there is actually something to say — probably a 10× cost
   reduction for this workload.

Neither blocks the design; both would make it better.

## Deliberate non-goals

- **Not a linter.** The navigator is told not to comment on style or anything a
  linter catches. That work is already automated and doing it again in prose is
  noise.
- **Not a code reviewer.** `pi-review` exists and does the after-the-fact pass
  properly. This is the during-the-work conversation, which is a different job:
  review catches what you wrote, a navigator catches what you were about to write.
- **Not an autocomplete.** No completions, no suggested patches. The driver types.
