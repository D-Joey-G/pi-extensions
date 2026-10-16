# pi-smalltalk

Swaps the agent's file and shell tools for a live, persistent [Pharo](https://pharo.org) Smalltalk image. The agent works the way a Smalltalker does: it browses the image, defines classes and methods, and evaluates code. Whatever it builds stays in the image across turns and sessions.

- `inspect_world` browses the image: an overview of your packages and workspace variables, class definitions and their methods by protocol, method source, packages, implementors, senders, references, substring search over classes and selectors, and the slots of any object an expression answers.
- `define_expression` defines or redefines a class (fluid syntax: `Object << #Account slots: { #balance }; package: 'Bank'`) or a method on a class or its class side.
- `execute_expression` evaluates statements and answers the result's class and printString, plus anything written to `Transcript`. Errors come back with their stack. Assigning to an undeclared name creates a workspace variable that persists, as in a Playground.

`/smalltalk on` makes these three tools the agent's only tools; `/smalltalk off` saves the image and restores the previous tools, and `/smalltalk` toggles. The mode is recorded in the session, so resuming a session resumes the mode. `pi --smalltalk` starts in it.

The filesystem stays reachable from Smalltalk: the VM runs in the project directory, so `'notes.txt' asFileReference contents` reads a project file and `LibC resultOfCommand: 'git status'` runs a shell command.

## The image

Each project gets its own image in `.pi/smalltalk/`, copied from a base Pharo 13 image the first time it is used. That directory carries a `.gitignore` of `*`, because the image is around 60 MB.

The image is saved after every definition and at the end of each agent run. Pharo's `.changes` file in the same directory logs the source of every definition. `/smalltalk save` saves on demand. `/smalltalk restart` quits without saving, so the next call resumes from the last save.

The VM starts on the first tool call and quits, after saving, when the session ends. Each evaluation runs in its own process with a timeout (30 s by default, `timeoutSeconds` up to 600), and pressing Escape interrupts it. A VM that stops answering altogether, or exits, is killed and restarted from its last save on the next call.

## Install

```sh
pi install npm:@djoeyg/pi-smalltalk
```

The first `/smalltalk on` downloads the Pharo 13 VM and image from files.pharo.org (about 100 MB) into `~/.pi/agent/smalltalk/`. Builds exist for macOS (Intel and Apple silicon) and Linux x86_64. Installation needs `unzip`.

## How it talks to the image

pi starts a headless VM that files in [`src/bridge.st`](src/bridge.st). The bridge serves JSON over HTTP on a random localhost port, and every request must carry a per-run token. Evaluations run below the server's priority, so a runaway loop can still be timed out or interrupted.
