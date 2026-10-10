# pi-fast

Sends OpenAI requests with `service_tier: "priority"` ([Fast mode](https://platform.openai.com/docs/guides/priority-processing)).

```
/fast          toggle
/fast on|off   set explicitly
```

The setting persists across sessions in `~/.pi/agent/fast.json`. A `⚡ fast` footer status shows while it's on.

Applies to the `openai` and `openai-codex` providers only. Priority processing bills a per-token premium over Standard.
