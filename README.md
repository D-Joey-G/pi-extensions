# pi-pair

A pair-programming mode for [pi](https://github.com/earendil-works/pi). You keep
the keyboard. The agent navigates: it watches your diffs land, asks the question
you were avoiding, and flags the design problem before it becomes a rewrite.

It cannot edit your files. That's the point.

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
pi install git:github.com/<you>/pi-pair
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
| `/pair mute` / `unmute` | Keep watching, stop talking. |
| `/pair notes` | Decisions, open questions, and risks from this session. |
| `/pair drive <task>` | Hand over the keyboard for one scoped task. |
| `/pair navigate` | Take it back. |
| `/pair status` | Current role, cadence, note count. |
| `Ctrl+G` | Same as `/pair look`. |

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
agent last looked is sent to it privately — it never clutters your transcript.
The agent must then answer with exactly one tool call: `interject` if it has
something worth interrupting you for, or `stay_quiet` if it doesn't. Most of the
time the right answer is `stay_quiet`, and the tooling is built so that's the
easy path.

Two separate throttles keep it from becoming noise. A gap clock, measured from
the last time it actually *spoke*, and an hourly cap on how many times it may
*look* (each look is a model request you pay for). Edits too small to be worth a
look aren't dropped — they accumulate until they add up to something.

It also leans in without being asked when a command you ran in the shell fails.

Design rationale, and the case for building this as an extension rather than
forking pi, is in [DESIGN.md](DESIGN.md).

## What it can and can't do

**Can't:** write, edit, or delete any file. Enforced twice — by removing the tools
and by blocking them at the call site — so it holds even if something else in
your session changes the tool set.

**Can:** read files, grep, and run read-only shell commands (`git log`, `git diff`,
`rg`, `npm test`, …) without asking. Anything outside that allowlist prompts you
first.

That screening is a heuristic, not a sandbox. It handles the obvious evasions —
compound commands are judged segment by segment, and redirections and command
substitutions always count as writes — but it isn't airtight. Set `strictBash` to
block bash outright if you need the guarantee to be real.

## Configuration

Cadence covers most of it. For the rest, the knobs are in `PairConfig`
(`src/config.ts`): `settleMs`, `minGapMs`, `maxObservationsPerHour`,
`minChangedLines`, `idleNudgeMs`, `maxPatchLines`, `maxFilesPerObservation`,
`strictBash`, and `ignore` (globs on top of the built-in list).

## Known limitations

- **Prose can leak.** The agent is told to answer observations with a bare tool
  call, but pi streams assistant text as it arrives, so a model that writes a
  preamble first will show it. Advisory, not enforced. See DESIGN.md.
- **Observations cost requests.** Each look is a call on your session's main
  model. That's what the hourly budget is for; `quiet` cadence if it matters.
- **Very large repos.** The baseline caps at 5,000 files. Past that, the first
  edit to an unbaselined file reads as a new file. The widget says so when it
  happens.

## Development

```sh
npm install
npm run check   # tsc
npm run lint    # biome
npm test        # node:test
```
