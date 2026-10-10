# pi extensions

Extensions for [pi](https://github.com/earendil-works/pi), the terminal-based coding agent.

| Package | Description |
| ------- | ----------- |
| [pi-usage](packages/pi-usage) | Remaining Claude / OpenAI / OpenCode Go quota as `/usage` overlay and footer status |
| [pi-fast](packages/pi-fast) | `/fast` toggle for OpenAI priority service tier |
| [pi-tps](packages/pi-tps) | Output tokens per second on the working spinner and footer |
| [pi-pair](packages/pi-pair) | Pair-coding mode: you drive, the agent navigates |

## Install

From source, add to `~/.pi/agent/settings.json`:

```json
{ "packages": ["/path/to/pi-extensions"] }
```

or install the package directly once published: `pi install npm:@joey/pi-usage`.
