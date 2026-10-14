# pi-pr-comments

Interactive GitHub pull-request feedback browser for Pi.

## Usage

```text
/pr-comments
/pr-comments 62
/pr-comments https://github.com/owner/repo/pull/62
/pr-comments:all
/pr-comments:all 62
/pr-comments --stack
/pr-comments:all --stack
```

With no PR argument, the command uses the pull request for the active branch. Select feedback with the arrow keys and Enter, optionally add instructions, and Pi receives the comment thread with its file, line, and source snippet. Press Tab in the browser to cycle through all, unresolved, and resolved review threads.

Press `a` in the browser, or run `/pr-comments:all`, to open an editable Markdown message containing every unresolved review thread and its source snippet. Submitting the editor sends the edited message to Pi.

## Stacked PRs

Use `/pr-comments --stack` to browse all comments across the current checkout's `gh stack`. The browser labels each item with its layer number, PR number, and branch. Layers are ordered bottom-to-top, and source snippets use each PR's own refs.

Use `/pr-comments:all --stack` (or press `a` in the stack browser) to edit and send all unresolved inline review threads, grouped by layer. The message identifies each layer's branch and base and tells Pi to fix the owning layer before rebasing upstack. Conversation comments and review summaries remain available in the browser but are not included in unresolved batches.

Stack mode requires the `github/gh-stack` CLI extension and a local stack. It skips merged layers and branches without PRs; layer numbers retain their position in the full stack. A failed layer aborts the load rather than silently sending a partial stack. `--stack` cannot be combined with a PR number or URL, and does not switch branches or modify the stack.

Requires an authenticated `gh` CLI. GitHub access is read-only.

## Install

```sh
pi install npm:@djoeyg/pi-pr-comments
```
