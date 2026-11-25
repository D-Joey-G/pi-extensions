# pi-agent-tab

Gives the agent an `agent` tool that launches a subagent: a separate pi process in its own background Rex tab. The tool returns at once. When the subagent finishes, it writes a markdown report and sends the parent an intercom message, which starts a turn in the parent.

```
agent({ task, cwd, model?, tools?, readOnly?, label? })
  → { blockId, label, reportPath, briefPath }
```

## How it works

The tool writes the task to `$TMPDIR/pi-agent-tab/<label>-XXXXXX/brief.md` with a footer that tells the child where to write its report and whom to message, then runs:

```
rex run -s $REX_BLOCK -c <cwd> --label <label> --keep-open --focus=false --json -- \
  pi --model <model> --tools <tools> --name <label> @brief.md
```

- **Model:** `provider/id[:thinking]` or a bare id, checked against `pi --list-models`. Unknown or ambiguous names fail with the closest matches. Default `openai/gpt-6.1-terra`.
- **Tools:** `readOnly` (default `true`) gives `read,bash,ffgrep,fffind,write,intercom` and tells the child to change nothing but its report. `readOnly: false` gives pi's default tools plus `intercom`, without `agent`. An explicit `tools` list replaces either; `write` and `intercom` are always added so the child can report.
- **Completion:** the parent's intercom ID comes from `PI_INTERCOM_SESSION_ID`, which [pi-intercom](https://www.npmjs.com/package/pi-intercom) sets. Without it, the extension watches the report file and posts a message when it appears.

Read-only is a prompt instruction, not a sandbox: the child still has `bash`. Subagent tabs stay open after they report; close them yourself.

## Requirements

- pi running inside a Rex terminal (`REX_BLOCK` set).
- `pi` on the login shell's `PATH`, since `rex run` starts a login shell.
- pi-intercom loaded in parent and child for the wake-up message.

## Install

```sh
pi install npm:@djoeyg/pi-agent-tab
```
