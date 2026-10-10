# pi-tps

Shows output tokens per second for assistant responses.

- **While streaming:** the working row reads `⠋ Working - 42.3 T/s`, estimated from streamed characters (~4 chars/token) and refreshed every 250ms.
- **When a message ends:** the rate is recomputed from the provider-reported `usage.output` and kept in the footer status.

The clock starts at the first streamed content event, so time-to-first-token is excluded and the figure reflects decode speed. Models that reason silently (no thinking deltas streamed) will read high, since their reasoning tokens count toward `usage.output` but the clock starts late.
