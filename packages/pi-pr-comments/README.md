# pi-pr-comments

Interactive GitHub pull-request feedback browser for Pi.

## Usage

```text
/pr-comments
/pr-comments 62
/pr-comments https://github.com/owner/repo/pull/62
/pr-comments --all
/pr-comments --all 62
```

With no PR argument, the command uses the pull request for the active branch. Select feedback with the arrow keys and Enter, optionally add instructions, and Pi receives the comment thread with its file, line, and source snippet. Press Tab in the browser to cycle through all, unresolved, and resolved review threads.

Press `a` in the browser, or pass `--all`, to open an editable Markdown message containing every unresolved review thread and its source snippet. Submitting the editor sends the edited message to Pi.

Requires an authenticated `gh` CLI. GitHub access is read-only.

## Install

```sh
pi install npm:@djoeyg/pi-pr-comments
```
