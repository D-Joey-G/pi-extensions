# pi-md

`/md` saves the last assistant message's text as a Markdown file.

```text
/md                # ./last_message.md
/md notes/design   # ./notes/design.md
```

Paths resolve against the working directory. `.md` is appended when missing, and parent directories are created.

## Install

```sh
pi install npm:@djoeyg/pi-md
```
