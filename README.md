# pi-pair

A pair-programming mode for [pi](https://github.com/earendil-works/pi). You keep
the keyboard. The agent navigates: it watches your diffs land, asks the question
you were avoiding, and flags the design problem before it becomes a rewrite.

It cannot edit your files while navigating. It can ask you to approve a scoped keyboard handoff.

```
/pair on

  … you write code …

  ! You're interpolating `x-user` straight into the SQL string. Is this
    reachable from an unauthenticated route?

  … you keep writing …

  ? handle() now returns three different shapes depending on the branch.
    Did you want the caller to switch on that, or should it throw?
```

## Install

```sh
pi install git:github.com/joeygoldman/pi-pair
```

Or for local development, point pi at the checkout:

```sh
pi -e ./src/index.ts
```

Requires pi ≥ 0.84.1 and Node ≥ 22.19.0.

## Usage

| Command | What it does |
| --- | --- |
| `/pair on [cadence]` | Start pairing. You drive, the agent navigates. |
| `/pair off` | Stop. Restores your original tool set. |
| `/pair quiet` · `normal` · `chatty` | How eagerly it speaks up. |
| `/pair look [question]` | Ask for its read right now, bypassing pacing. |
| `/pair mute` / `unmute` | Stop volunteering remarks. `/pair look` still works. |
| `/pair notes` | Decisions, open questions, and risks from this session. |
| `/pair drive <task>` | Hand over the keyboard for one scoped task. |
| `/pair navigate` | Take it back. |
| `/pair status` | Current role, cadence, note count. |
| `/pair config` | Show every setting and its current value. |
| `/pair set <key> <value>` | Change one setting. |
| `Alt+G` | Same as `/pair look`. |

> pi reserves every `Ctrl+<letter>`, so the shortcut lives under Alt. On macOS
> terminals you may need "Use Option as Meta key" enabled for it to register;
> `/pair look` always works regardless.

### Cadence

|  | Speaks at most | Reacts to | Idle nudge |
| --- | --- | --- | --- |
| `quiet` | every 10 min | 25+ changed lines | off |
| `normal` | every 3 min | 8+ changed lines | after 12 min |
| `chatty` | every 45 s | 3+ changed lines | after 5 min |

`normal` is the default and is meant to feel like a real pair: a remark every few
minutes, not a running commentary.

## How it works

A file watcher notices your edits and waits for you to pause. The diff since the
agent last looked is sent to it privately — an unprompted look never appears in
your transcript. (`/pair look` is your question, so that one does.) The agent
must then answer with exactly one tool call: `interject` if it has something
worth interrupting you for, or `stay_quiet` if it doesn't. Most of the time the
right answer is `stay_quiet`, and the tooling is built so that's the easy path.

Three throttles keep it from becoming noise. A gap clock, measured from the last
time it actually *spoke*; an hourly cap on how many times it may *look* (each
look is a model request you pay for); and a rule that it never starts a second
look while it is still thinking about the first. Edits too small to be worth a
look aren't dropped — they accumulate until they add up to something, and once
shown they are never shown again.

It also leans in without being asked when a command you ran in the shell fails.

Design rationale, and the case for building this as an extension rather than
forking pi, is in [DESIGN.md](DESIGN.md).

## What it can and can't do

**Can:** inspect the workspace with `read`, `grep`, `ls`, and `find`.

**Can't:** use `bash`, edit files, or call unknown tools while navigating. The
tool gate is an allowlist, not a list of known
writers — a tool pi adds tomorrow, an MCP server you connect, or another
extension's tool is refused because it isn't on the list, not permitted because
nobody thought to ban it. Enforced twice, by trimming the active tool set and by
blocking at the call site, so it holds even if something else in your session
changes the tools.

When a scoped implementation would be more useful than advice, the navigator can
call `request_drive`. You see the proposed task and expected files in a confirmation
dialog. Approval restores your original tool set for that agent run; once it
settles, the extension automatically returns to navigator mode. Declining leaves
the tool set unchanged. `/pair drive <task>` remains the explicit manual handoff.

The cost is that read-only MCP tools are blocked too until you say otherwise:

```sh
/pair set extraReadOnlyTools mcp__sentry__get_issue,mcp__linear__get_issue
```

Shell access is deliberately unavailable to the navigator. Rather than trying to
classify arbitrary shell syntax as safe, the extension fails closed and requires
a keyboard handoff.

## Configuration

Cadence covers most of it. `/pair config` shows the rest, and `/pair set <key>
<value>` changes one:

| Key | What it does |
| --- | --- |
| `settleMs` | Quiet period before a burst of edits counts as finished. |
| `minGapMs` | Minimum time between two unprompted remarks. |
| `maxObservationsPerHour` | Cap on paid looks per rolling hour. |
| `minChangedLines` | Bursts smaller than this wait for the next one. |
| `idleNudgeMs` | Offer help after this long with no edits. `0` disables it. |
| `maxPatchLines` | Truncate each file's diff before sending. |
| `maxFileBytes` | Represent larger files by size/type metadata instead of reading their contents. |
| `maxFilesPerObservation` | Cap on files described in one observation. |
| `ignore` | Extra ignore globs, comma-separated. |
| `extraReadOnlyTools` | Extra tools the navigator may call, comma-separated. |

Settings survive a cadence change and are restored with the session. Cadence
presets own the first five; setting one of those explicitly overrides the preset
until you set it again.

## Known limitations

- **Prose can leak.** The agent is told to answer observations with a bare tool
  call, but pi streams assistant text as it arrives, so a model that writes a
  preamble first will show it. Advisory, not enforced. See DESIGN.md.
- **Observations cost requests.** Each look is a call on your session's main
  model. That's what the hourly budget is for; `quiet` cadence if it matters.
- **Very large repos.** The baseline caps at 5,000 files. Past that, the first
  edit to an unbaselined file reads as a new file. The widget says so when it
  happens.
- **MCP tools are off by default.** The allowlist can't tell a read-only MCP tool
  from a writing one, so it refuses both until you name them in
  `extraReadOnlyTools`. The block message tells the agent to say so.

## Development

```sh
npm install
npm run check   # tsc
npm run lint    # oxlint + oxfmt
npm test        # node:test
```
