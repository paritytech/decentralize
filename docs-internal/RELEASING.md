# Releasing @paritytech/decentralize

Internal release process — not something npm consumers need to read. Covers
how to cut a release of this package and get it onto npm.

`@paritytech/decentralize` has never been published. There is no tag, no
GitHub release, and no publish history yet. This doc, plus
`.github/workflows/publish.yml` and `.github/workflows/promote.yml`, exist to
give this its first release path (modelled on how `bulletin-deploy` — this
package's own dependency — does it), but the one-time bootstrap below has
not been exercised end to end.

## One-time bootstrap (do this before the first real release)

npm's trusted-publisher configuration (the OIDC mechanism `publish.yml` uses
to authenticate to npm without a stored token) is configured **per package**
on npmjs.com, and a package's trusted publisher normally cannot be set up
before the package exists on the registry at all. The expected sequence is:

1. Someone with `@paritytech` npm org publish rights does a **first manual
   publish** from their own machine:
   ```sh
   npm publish --access public --registry https://registry.npmjs.org
   ```
   `--access public` is required — this is a scoped package
   (`@paritytech/...`) and has never been published, so npm would otherwise
   default a scoped package's first publish to restricted.
2. Once `@paritytech/decentralize` exists on npm, configure the **trusted
   publisher** for it on npmjs.com (package page -> Settings -> Trusted
   Publisher), pointing at this repo's `publish.yml` workflow.
3. From then on, `publish.yml` publishes via OIDC with no stored token.

**This sequence is expected, not confirmed.** Verify it against npmjs's
current documented behaviour before relying on it — npm has changed trusted
publishing details before, and it's plausible the exact bootstrap flow (e.g.
whether trusted publishing can now be pre-configured for a not-yet-published
name) has moved since this was written. Don't treat this doc as the source
of truth for npm's own product behaviour.

## The local-registry hazard

This machine's (and likely every Parity-managed machine's) npm registry is
configured to a Parity proxy, not npmjs directly:

```
$ npm config get registry
https://registry.security.parity.io/npm/
```

A bare `npm publish` run locally targets that proxy, **not** npmjs.com. Any
manual publish (the bootstrap step above, or an emergency manual publish
later) must pass the registry explicitly:

```sh
npm publish --access public --registry https://registry.npmjs.org
```

In CI this is handled automatically — `actions/setup-node@v6`'s
`registry-url: 'https://registry.npmjs.org'` input writes a `.npmrc` that
points `npm publish` at npmjs.com regardless of any ambient registry config
on the runner.

## The normal release cycle

1. Bump the version in `package.json` on a branch, open a PR, get it
   reviewed and merged to `main`. `Unit Tests` (`.github/workflows/tests.yml`)
   is the required check — it does not touch npm.
2. Cut a GitHub release whose **tag matches the version** exactly (a `v`
   prefix is tolerated — `v0.1.0-rc.1` or `0.1.0-rc.1` both work). This is
   the trigger: `publish.yml` runs on `release: types: [created]`.
3. `publish.yml` runs. It first checks the release tag against
   `package.json`'s version and fails loudly if they don't match (a
   deliberate addition beyond what bulletin-deploy's own publish.yml does —
   bulletin-deploy trusts the tag was cut correctly and only reads
   package.json). Then it runs this repo's own gates (`npm ci`, typecheck,
   test, build) as a fast fail-early check, then publishes:
   - a version containing `-` (e.g. `0.1.0-rc.1`) publishes under the `rc`
     dist-tag, so a plain `npm install @paritytech/decentralize` never picks
     it up;
   - a version with no `-` publishes to `@latest` directly.
4. For a prerelease, **validate it by hand** (see below), then promote it
   with `promote.yml`.

## Validating a prerelease before promoting

Be honest about what actually gets tested here. This repo's E2E suite
(`.github/workflows/e2e.yml`) runs from `main`, builds `dist/` from source,
and runs nightly at 03:17 UTC (or on `workflow_dispatch`) — it **never
installs the published tarball**. A green nightly says the source on `main`
works against a live chain; it says nothing about whether the tarball
`publish.yml` just pushed to npm is intact.

So "validating an rc" here means an actual manual check of the published
artifact, not an automated gate:

```sh
npx @paritytech/decentralize@rc --help
```

This is the safe zero-dependency check — `--help` doesn't touch the
network, IPFS, or a chain. A fuller smoke test —

```sh
npx @paritytech/decentralize@rc ./some-fixture --dot smoke-test-rc --dry-run
```

— exercises real staging logic, but note `--dry-run` does **not** skip this
tool's own preflight: it still requires the `ipfs` (Kubo) binary on `PATH`
(or `--js-merkle` passed explicitly), the same as a real deploy. Run it
somewhere Kubo is installed, or add `--js-merkle` if you're checking it
somewhere that isn't.

Only after one of these has actually been run against the published rc
should you promote it.

## Promoting a prerelease to @latest

`promote.yml` is `workflow_dispatch` with a `version` input. From the
Actions tab: **Promote RC to latest -> Run workflow -> version: 0.1.0-rc.1**.

It validates the input is non-empty and a real semver prerelease, checks
`NPM_TOKEN` is actually configured (see below), verifies the version really
exists on npm, shows dist-tags before promoting, runs
`npm dist-tag add @paritytech/decentralize@<version> latest`, then verifies
the promotion stuck by re-reading `@latest`.

**This needs a secret this repo does not have yet.** `npm dist-tag add`
authenticates with a token, not OIDC — trusted publishing (used by
`publish.yml`) only covers `npm publish`. Before the first promotion, add an
**`NPM_TOKEN`** repository secret (Settings -> Secrets and variables ->
Actions), an npm **Automation** token with publish rights on
`@paritytech/decentralize`. A non-Automation token will fail with `EOTP`
(demanding 2FA CI cannot answer) — this is exactly the trap bulletin-deploy
hit (its issue #1277) before it moved `publish.yml` itself to OIDC.
`promote.yml` fails fast with an actionable message if `NPM_TOKEN` is unset,
rather than surfacing a confusing auth error later in the run.

## Recommended first release: `0.1.0-rc.1`, not `0.1.0`

The README labels this package a prototype (`> [!WARNING] Prototype /
reference implementation. Not audited, actively experimental...`), and the
only chain validation this repo has is a nightly run off `main` — there is
no history yet of a real install being exercised. Cutting the very first
release as `0.1.0-rc.1` (rc dist-tag, not `@latest`) means the first thing
anyone can `npm install @paritytech/decentralize` unqualified is a version
that has already been smoke-tested per the section above, not whatever the
bootstrap publish happened to produce. Promote to `0.1.0` only once that
rc's tarball has actually been run.

## What the published tarball contains

Verified locally with `npm pack --dry-run` against the current tree: **9
files, 34.5 kB** —

```
dist/cli.d.ts
dist/cli.js
dist/cli.js.map
dist/index.d.ts
dist/index.js
dist/index.js.map
LICENSE
README.md
package.json
```

`dist/`, `README.md`, and `LICENSE` come from package.json's `files` list.
**`package.json` itself ships regardless of that list** — npm always
includes a package's own manifest in the tarball, `files` or not — and this
matters beyond convention: `src/cli.ts`'s `ownVersion()` walks up from the
installed `dist/cli.js` looking for the nearest `package.json` specifically
to read this package's own version for Sentry host-app attribution
(`BULLETIN_DEPLOY_HOST_APP_VERSION`). If `package.json` were ever missing
from the tarball, that attribution would silently go blank rather than
error — see `ownVersion()`'s own comment on never letting a telemetry
attribute fail a deploy.
