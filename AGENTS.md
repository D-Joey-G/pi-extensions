# pi-extensions

Monorepo of pi extensions, each published to npm as `@djoeyg/<package>`. pi loads the `.ts` sources directly; there is no build step.

## Changes to a package

Every PR that changes a package's published files ships a changeset: run `npx changeset`, pick the packages and bump level, and commit the generated `.changeset/*.md`. Versions and changelogs belong to the release workflow; leave `version` fields and `CHANGELOG.md` files to it.

Before committing, `npm run check`, `npm run lint` and `npm test` all pass.

## Releases

`.github/workflows/release.yml` publishes through npm trusted publishing. Each package's trusted publisher on npm names that exact file, so the filename and the `repository` field in each `package.json` stay as they are.

Merging to `main` opens or updates a "Version packages" PR; merging that PR publishes. `npx changeset publish-plan` shows what the next release would publish.

## Adding a package

1. Create `packages/<name>/` with `index.ts`, `README.md`, `LICENSE` and a `package.json` modelled on `packages/pi-tps/package.json` (`@djoeyg/` scope, `repository.directory`, `files`, `publishConfig.access: public`).
2. Register it in the root `package.json` `pi.extensions`, and in `tsconfig.json` `include` when it has no tsconfig of its own.
3. Add a row to the README table.
4. Run `npm install --package-lock-only` and commit the `package-lock.json` change. CI runs `npm ci`, which fails when a new workspace is missing from the lockfile. `npm ci --dry-run` confirms it is in sync.
5. A brand-new name has to exist on npm before trusted publishing can attach to it. Hand the user these two commands to run themselves, since they need their npm login and 2FA:

   ```sh
   npm publish -w @djoeyg/<name>
   npm trust github @djoeyg/<name> --file release.yml --repo D-Joey-G/pi-extensions --allow-publish -y
   ```
