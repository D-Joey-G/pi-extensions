# pi-worktree

Tabs inside pi, one per git worktree. `/worktree <branch>` forks the current conversation into a new worktree and opens it in a tab. The worktree agent runs in parallel with the main session and with every other tab.

```
 1 main │  2 feat-auth ● │ 3 fix-flaky-test ✓
```

## Commands

- `/worktree <branch> [prompt]` creates `<repo>.worktrees/<branch>` next to the main checkout and opens a tab there. A new branch starts from the current HEAD; an existing branch is checked out. The tab's agent continues the conversation from where the main session is now, on the same model and thinking level. If you give a prompt, it goes to the new agent straight away.
- `/worktree <branch>` on a worktree that already exists, for example after restarting pi, continues that worktree's latest session instead of forking again.
- `/worktree` with no argument reopens the last tab, or asks for a branch if there are none.
- `/worktree close <branch>` stops the tab's agent. The worktree and branch stay.
- `/worktree remove <branch>` also runs `git worktree remove` once you confirm. The branch stays, and uncommitted changes block the removal.

## Keys

| Key | Where | Action |
| --- | --- | --- |
| Alt+W | main | Open the last tab |
| Alt+2…9 | anywhere | Go to tab N |
| Alt+1 | tab | Back to main |
| Alt+W | tab | Next tab; past the last one, back to main |
| Enter | tab | Send. While the agent is working, this steers it |
| Esc | tab | Abort the run; when idle, back to main |
| PgUp / PgDn / wheel | tab | Scroll |
| Ctrl+O | tab | Expand or collapse tool output |

On macOS, Alt shortcuts need the terminal to send Option as Alt, e.g. `macos-option-as-alt = true` in Ghostty.

The footer lists the tabs: `●` working, `✓` finished since you last looked, `○` idle, `✗` exited. When a background tab finishes, pi posts a notification.

## How it works

Each tab is a headless `pi --mode rpc` process started in the worktree directory, the same way `pi-review` runs its reviewer. The worktree's own `AGENTS.md`, project settings, and project extensions apply, and one agent crashing doesn't take down the others. A new worktree gets `--fork <current session>`, plus a system-prompt note telling the agent its new working directory, since earlier messages refer to the original checkout. The fork is saved as a normal pi session under the worktree's directory, so `pi --continue` from inside the worktree resumes it.

The worktree uses the main checkout's project-trust decision, because a fresh path has no saved trust and RPC mode cannot ask. Dialogs from extensions in a tab (`confirm`, `select`, `input`, `editor`) show up in the main UI, prefixed with the branch name. Notifications go to the main chat.

Tabs survive `/reload`, `/new` and `/resume`. Quitting pi stops every tab's agent.

## Limits

- A tab is a chat with an editor, not pi's whole interface. Extension commands work in a tab. Built-in interactive commands such as `/tree`, `/model` and `/compact` do not.
- Tools that pi doesn't ship are drawn with the generic renderer, not their extension's own.
- A worktree starts as a clean checkout: no `node_modules` and no untracked files such as `.env`.

## Install

```sh
pi install npm:@djoeyg/pi-worktree
```
