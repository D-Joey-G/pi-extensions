# pi-usage

Remaining subscription quota for [pi](https://github.com/earendil-works/pi), the terminal-based coding agent, covering Claude, OpenAI (Codex) and OpenCode Go.

- **/usage overlay** — one section per provider; each window shows a bar of quota remaining, the percentage left and a reset countdown. `r` refreshes, `esc` closes. Results fill in as each provider responds.
- **Footer status** — compact `Provider 89%` percentages, refreshed every 5 minutes. The provider of the currently selected model is shown first, with a thin bar.
- **Theme aware** — all colours use pi's theme tokens: accent when healthy, `warning` below 30%, `error` below 10%.

## Providers

| Provider | Source | Shows |
| -------- | ------ | ----- |
| Claude | Claude Code keychain login | 5 hour + weekly windows (Opus/Sonnet and extra credits when present) |
| OpenAI | `~/.codex/auth.json` ChatGPT login | primary + secondary windows, code review limits |
| OpenCode Go | `~/.pi/agent/auth.json` or `$OPENCODE_API_KEY` | 5 hour + weekly + monthly windows |

Credentials are only read, never refreshed — run `claude` / `codex` once yourself to refresh an expired login.

### OpenCode Go endpoint

`https://opencode.ai/zen/go/v1/usage` is undocumented and could change.

## Configuration

By default all three providers show. To hide some, create `~/.pi/agent/pi-usage.json`:

```json
{ "providers": ["claude"] }
```

or set the environment variable `PI_USAGE_PROVIDERS=claude,openai`.
Run `/reload` after changing either.

## Install

```shell
pi install npm:@joey/pi-usage      # once published
pi install /path/to/pi-extensions  # or from this repo
```
