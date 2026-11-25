# pi-agent-tab

Gives the agent an `agent` tool that launches a subagent: a separate pi process in its own background Rex tab. The tool returns at once. When the subagent finishes, it writes a markdown report and sends the parent an intercom message, which starts a turn in the parent.

```
agent({ task, cwd, mode?, model?, tools?, readOnly?, skills?, label? })
  → { blockId, label, reportPath, briefPath }
```

## How it works

The tool writes the task to `$TMPDIR/pi-agent-tab/<label>-XXXXXX/brief.md` with a footer that tells the child where to write its report and whom to message, then runs:

```
rex run -s $REX_BLOCK -c <cwd> --label <label> --keep-open --focus=false --json -- \
  pi --model <model> --tools <tools> --name <label> \
     [--skill <file>]... [--append-system-prompt mode.md] @brief.md
```

- **Model:** `provider/id[:thinking]`, a bare id, or an alias: `opus`, `sonnet`, `terra`, `sol` (each takes `:thinking` too). Checked against `pi --list-models`; unknown or ambiguous names fail with the closest matches. Default `openai/gpt-6.1-terra`. "An opus worker" is `agent({ mode: "worker", model: "opus", ... })`.
- **Tools:** `readOnly` (default `true`) gives `read,bash,ffgrep,fffind,write,intercom` and tells the child to change nothing but its report. `readOnly: false` gives pi's default tools plus `intercom`, without `agent`. An explicit `tools` list replaces either; `write` and `intercom` are always added so the child can report.
- **Completion:** the parent's intercom ID comes from `PI_INTERCOM_SESSION_ID`, which [pi-intercom](https://www.npmjs.com/package/pi-intercom) sets. Without it, the extension watches the report file and posts a message when it appears.
- **Talking mid-task:** the child's intercom name is its label, by default the mode plus the task's first words (`worker-fix-the-runner-1a2b`). The parent can send it new instructions; the child asks the parent when blocked on a decision.
- **Every brief** tells the child the parent can't see its tab, to lead with the answer and evidence, and how to use intercom.

Read-only is a prompt instruction, not a sandbox: the child still has `bash`. Subagent tabs stay open after they report; close them yourself.

## Modes

A mode presets the model, tools and a role prompt for a kind of job. The `agent` tool's description lists the available modes, so the agent can pick one.

| Mode | Model | Access | For |
| ---- | ----- | ------ | --- |
| `scout` | `openai/gpt-6.1-terra` | read-only | Finding code and facts, reported with `path:line` evidence |
| `worker` | `openai/gpt-6.2-sol` | read-write | Implementing a bounded change and verifying it, following `code-principles` and `test-audit` |
| `review` | `claude-bridge/claude-opus-5-5:high` | read-only | A strict one-shot review with findings and a verdict, following `thermo-nuclear-code-quality-review`, `code-principles` and `test-audit` |

`review` is a single pass in a tab. For a review the agent can argue with and re-run, use [pi-review](../pi-review).

A mode is a markdown file. The frontmatter sets the launch; the body is appended to the child's system prompt.

```markdown
---
name: docs
description: Updates READMEs and docs to match the code. Does not touch source.
model: claude-bridge/claude-opus-5-5:high
readOnly: false
tools: read, bash, edit, write
skills: [writing-for-agents, ./skills/house-style]
---

You update documentation only. Read the code first; never change it.
```

| Field | Required | Meaning |
| ----- | -------- | ------- |
| `name` | yes | What `mode` refers to. Letters, digits, `_` and `-`. |
| `description` | yes | One line, shown in the tool description. |
| `model` | no | `provider/id[:thinking]` or an alias. Default `openai/gpt-6.1-terra`. |
| `readOnly` | no | Default `true`. As for the tool argument. |
| `tools` | no | Exact allowlist, as a list or comma-separated. `write` and `intercom` are always added. |
| `skills` | no | Skill names, or paths relative to the mode file. The child gets each with `--skill` and is told to read it before starting. |

Other fields are an error, so a typo does not silently do nothing.

Modes load from three places. A later one replaces an earlier one with the same name:

1. The built-ins in this package.
2. `~/.pi/agent/agent-modes/*.md`.
3. `.pi/agent-modes/*.md` in the session's working directory, once the project is trusted.

Files are re-read on every launch. The tool description updates at session start and on `/reload`. A malformed file is skipped with a warning naming it, and launching a mode that is unknown or malformed fails with the reason.

Explicit arguments override the mode field by field: `model`, `readOnly`, `tools` and `skills` each replace the mode's value when given. For example, `agent({ mode: "scout", readOnly: false, ... })` keeps scout's model and prompt but gives the child write tools.

## Requirements

- pi running inside a Rex terminal (`REX_BLOCK` set).
- `pi` on the login shell's `PATH`, since `rex run` starts a login shell.
- pi-intercom loaded in parent and child for the wake-up message.

## Install

Not published to npm. Install it from GitHub:

```sh
pi install git:github.com/D-Joey-G/pi-extensions
```

or add `packages/pi-agent-tab/src/index.ts` to the `extensions` filter of an existing entry for that source.
