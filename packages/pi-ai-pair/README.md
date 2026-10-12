# pi-ai-pair

`/ai-pair` runs an implementer/reviewer loop with two models.

1. The current session's implementer model writes a distilled plan of the work agreed so far to `plan.md`.
2. It implements the plan.
3. A reviewer model runs in a separate headless pi process, reads the plan and the git diff, and calls `submit_review` with a verdict and findings.
4. The implementer fixes or disputes each finding. Steps 3–4 repeat until the reviewer approves or the round limit is hit, at which point you choose to stop or run another round.

The final report (outcome, findings per round, diffstat) is posted to the session.

## Usage

```text
/ai-pair
/ai-pair --rounds 5
/ai-pair --confirm-plan focus on the parser changes
```

- `--rounds N`: maximum review rounds (default 3).
- `--confirm-plan`: pause for confirmation after the plan is written.
- Remaining text is passed as the plan's focus.

Press Esc or Ctrl-C to interrupt the reviewer.

The command picks both models interactively and remembers the choice in `~/.pi/agent/ai-pair.json`. It needs an interactive session inside a git repo. Run artifacts (plan, reviewer session, scratch dir) go to `<repo>/.pi/ai-pair/<run-id>/`, which is git-ignored.

## Install

```sh
pi install npm:@djoeyg/pi-ai-pair
```
