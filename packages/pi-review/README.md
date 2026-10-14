# pi-review

Gives the agent a background code reviewer it can steer.

- `request_review` starts a reviewer and returns a review id (`R1`, `R2`, …) immediately. The reviewer is a headless pi on its own model, with fresh context and read-only tools (`read`, `grep`, `find`, `ls`, `bash`). When it finishes, its verdict and findings arrive in the session as a message, which starts a turn if the agent is idle.
- `steer_review` messages a review. While it runs, the message redirects it. After it finishes, the message starts another round in the same reviewer context, so the agent can dispute findings or ask for a re-review after fixing them.

Reviewers live until the session ends. The footer shows which are running.

`/review off` removes both tools from the agent and stops running reviewers; `/review on` restores them, and `/review` toggles. The choice persists in `~/.pi/agent/review.json` as `"enabled"`.

The reviewer prompt ([`src/reviewer.md`](src/reviewer.md)) asks for a strict maintainability review: correctness first, then structural simplification, ownership boundaries, and illegal state.

## Models

The agent picks the reviewer model per request. Offer it a menu in `~/.pi/agent/review.json`: keys are `provider/id`, optionally with a `:thinking` suffix, and values say when to pick each. The first entry is the default.

```json
{
  "models": {
    "openai/gpt-6.1-sol:high": "Default. Deep structural and correctness review.",
    "claude-bridge/claude-opus-5-5:high": "Second opinion from another model family; large or cross-cutting changes.",
    "openai/gpt-6-luna:medium": "Small, low-risk diffs where speed matters."
  }
}
```

Without a menu, the agent may name any model that has credentials, and defaults to its own. An optional `"promptFile"` (absolute path) replaces the bundled reviewer prompt.

## Install

```sh
pi install npm:@djoeyg/pi-review
```
