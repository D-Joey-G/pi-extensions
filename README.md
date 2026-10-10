# pi extensions

Extensions for [pi](https://github.com/earendil-works/pi), the terminal-based coding agent.

| Package | Description |
| ------- | ----------- |
| [@djoeyg/pi-usage](packages/pi-usage) | Remaining Claude / OpenAI / OpenCode Go quota as `/usage` overlay and footer status |
| [@djoeyg/pi-fast](packages/pi-fast) | `/fast` toggle for OpenAI priority service tier |
| [@djoeyg/pi-tps](packages/pi-tps) | Output tokens per second on the working spinner and footer |
| [@djoeyg/pi-emoji](packages/pi-emoji) | Slack-style `:emoji:` and kaomoji completion, with custom entries |
| [@djoeyg/pi-pair](packages/pi-pair) | Pair-coding mode: you drive, the agent navigates |

## Install

One extension:

```sh
pi install npm:@djoeyg/pi-tps
```

All of them, from git:

```sh
pi install git:github.com/D-Joey-G/pi-extensions
```

## Development

```sh
npm install
npm run check   # type-check every package
npm test        # run package tests
```

To develop against a checkout, add its path to `packages` in `~/.pi/agent/settings.json`.

## Releasing

Packages are versioned independently with [changesets](https://github.com/changesets/changesets).

1. In a PR that changes a package, run `npx changeset` and commit the generated file.
2. On merge to `main`, the release workflow opens (or updates) a "Version packages" PR that bumps versions and changelogs.
3. Merging that PR publishes the bumped packages to npm via trusted publishing, with provenance.

## License

MIT
