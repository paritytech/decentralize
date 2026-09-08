# decentralize

Take a folder (or a single HTML file), turn it into a correct single-page-app
archive, and deploy it to the [Polkadot Bulletin Chain](https://github.com/paritytech/polkadot-bulletin-chain)
under a DotNS name.

> [!WARNING]
> Prototype / reference implementation. Not audited, actively experimental, and
> targets Polkadot **testnets**. Use at your own risk.

This is a thin preprocessor in front of [`bulletin-deploy`](https://www.npmjs.com/package/bulletin-deploy),
which does all the actual work — chunked upload, DAG-PB/CAR content addressing,
DotNS commit-reveal registration. `decentralize` fixes up your build output so
the result actually renders, prints exactly what it changed, then hands off and
gets out of the way. All of bulletin-deploy's output passes through unfiltered.

## Install

```sh
npm install
npm run build
```

Requires **Node.js >= 22** and the IPFS [Kubo](https://docs.ipfs.tech/install/)
binary (`ipfs`) on your `PATH`.

## Usage

```sh
decentralize ./dist --dot my-app
decentralize ./app.html --dot my-app            # single file
decentralize ./dist --dot my-app --dry-run      # stage + print the plan only
decentralize ./dist --dot my-app -- --env summit --password hunter2
```

| Option | Meaning |
| --- | --- |
| `--dot <name>` | DotNS name. Required. The TLD comes from the target environment (`--env`) — e.g. paseo-next-v2 registers under `.paseo`. |
| `--path <dir>` | Explicit alternative to the bare positional source. |
| `--entry <file>` | Entry file to use as `index.html`, skipping auto-detection. |
| `--fallback` | Also write `404.html` + `_redirects` (off by default — see below). |
| `--keep-staging` | Leave the staging directory on disk to inspect. |
| `--dry-run` | Stage and print the plan; deploy nothing. |

Any flag this tool does not recognise is forwarded to `bulletin-deploy`
verbatim (`--env`, `--password`, `--publish`, `--mnemonic`, `--js-merkle`, …).
Use `--` to end this tool's own parsing when a forwarded flag would otherwise be
ambiguous.

**The TLD comes from the target environment, not from `--dot`.** `--dot` only
carries the label — `my-app`, not `my-app.paseo`. This tool forwards that
label to `bulletin-deploy`, which applies whichever suffix the environment you
deploy to (`--env`, itself forwarded — see above) actually uses:
`paseo-next-v2` (the default) registers under `.paseo`; `preview` uses
`.testnet` (re-rooted from `.dot` in bulletin-deploy 0.16.0, PR #1324); most
other environments carry no fixed suffix at all. A trailing
`.dot` typed on `--dot` is stripped for backward compatibility (every example
before bulletin-deploy 0.15.0 spelled it out), but this tool does not append
one — guessing the right suffix per environment would mean copying
bulletin-deploy's environment table here, and that copy would rot the moment
a new network is added upstream. Pass the bare label and let bulletin-deploy
pick the suffix.

## What it actually does

1. **Copies** your source into a temp staging directory. Your build output is
   never modified.
2. **Excludes** `.git`, `.bulletin-deploy`, `node_modules` and `.DS_Store`.
   Everything uploaded becomes a public website; pointing this at a project root
   should not publish your repository history.
3. **Guarantees `index.html` at the archive root** — the one thing that matters
   (see below). In order: an existing root `index.html`; a lone root `*.html`
   renamed; a recognisable entry (`main`/`app`/`home`/`default`.html) chosen from
   several; otherwise the shallowest nested `index.html` is hoisted to become the
   root. Ambiguity is an error naming the candidates, not a guess.
4. **Writes nothing else by default.** `404.html` + `_redirects` are only
   written with `--fallback` (see below for why that's the default now).
5. **Runs `bulletin-deploy`** against the staged directory with your DotNS
   label — bare, so bulletin-deploy applies the target environment's own TLD.

## Why `index.html` at the root is the whole point

The Polkadot app sandbox loads deployed content by asking the archive for a root
document. If there isn't one it refuses outright:

```
Failed to load content
Archive missing index.html — cannot render a sandbox without a root document.
```

So a build whose entry is `main.html`, or that nests its output one directory
deeper, does not merely lose deep links — **it does not load at all**. Verified
with two live deploys of identical content, one renamed and one not.

## Deep links do not work, and no upload can fix that

Worth stating plainly, because it is counter-intuitive and cost us a round of
testing to establish. SPA routes are **not addressable** on this platform:

- The sandbox origin refuses top-level entry — `"not a standalone entry point"` —
  so a deep URL cannot be opened or shared directly. Adding the `cid` query
  parameter does not help.
- The host frames the app as `<name>.app.<gateway>/?cid=<root>&…`, and the
  sandbox then **scrubs its own query string**. An in-frame reload therefore
  re-requests the path without the required `cid`, gets
  `"Invalid sandbox URL — missing required URL param cid"`, and the host restarts
  the app at its root.
- The address bar only ever shows the host URL, which does not encode the app's
  internal route.

The sandbox service worker does have an SPA fallback that stops a path request
from hard-404ing, but the route always resets to home. **Keep routing in memory;
do not promise users refresh-to-route or shareable deep links.**

Consequently `404.html` and `_redirects` are read by neither the sandbox nor
polkadot-desktop — they only matter on a plain Kubo gateway. That makes them
the wrong default: `404.html` is written as a byte-identical copy of
`index.html`, which simply doubles the bytes bulletin-deploy has to chunk and
upload for a file nothing in this tool's real deployment targets ever reads.
Measured on a live deploy: a 1,708,272-byte single-file app produced 19
on-chain chunks (nonces 37211–37228) because the duplicate `404.html` doubled
the payload — and the duplicate blocks carry identical CIDs and still get
uploaded twice. It compounds with
[bulletin-deploy#1233](https://github.com/paritytech/bulletin-deploy/issues/1233):
`packSection` fragments files in the 1–2 MB band into one chunk per 256 KB IPFS
block (2.0 MB → 8 chunks, 2.2 MB → 2 chunks), so for a file in that band the
duplicate is not merely +100% — it's +100% of an already-inflated chunk count.

So fallback files are **off by default**. Pass `--fallback` to opt in if you
actually serve from a plain Kubo gateway. `--no-fallback` is still accepted (as
a no-op) so existing scripts and CI invocations keep working unchanged.

## Naming: exactly 0 or 2 trailing digits

DotNS (PopRules) accepts a label with **exactly zero or two trailing digits**;
anything else reverts on-chain. bulletin-deploy responds by *rewriting* such
labels — and on 0.13.x it did so on the registration path, silently retargeting
the deploy at a different name ([its issue #1189](https://www.npmjs.com/package/bulletin-deploy)).
Observed live: `--dot my-app3` became `my-app.dot` (`.dot` was the only TLD
that existed at the time), an already-owned live name, and the deploy went on
to offer to overwrite its content. The hazard — silently landing on a
different, already-owned name — is the same regardless of which TLD the
target environment uses today.

This tool refuses such labels up front and tells you what they would have become:

```
✖ --dot "my-app3" has 1 trailing digit; DotNS (PopRules) accepts exactly 0 or 2.
  bulletin-deploy would rewrite it to "my-app" instead of failing …
```

Use a label ending in a letter, or in exactly two digits (`my-app01`).

## Kubo is required on purpose

bulletin-deploy can content-address in pure JavaScript via `--js-merkle`, and
that path has historically produced un-walkable CARs. The failure mode is silent:
the deploy **succeeds** and the site serves 404s. A missing `ipfs` binary is a
loud error fixed by one `brew install ipfs`; a bad CAR costs you an afternoon. So
this tool requires Kubo and never substitutes the JS merkleizer behind your back.
Pass `--js-merkle` yourself if you genuinely need it (WebContainer, CI images
with no native binary).

## Pinned dependency

`bulletin-deploy` is a pinned dependency and the tool invokes **that** copy, not
whatever is on your `PATH` — an unpinned version can silently retarget a deploy
(above). Set `BULLETIN_DEPLOY_BIN` to point at a local checkout when developing
against an unreleased version.

## Development

```sh
npm run typecheck
npm test
npm run build
```

## Licence

GPL-3.0-or-later, matching [`bulletin-deploy`](https://www.npmjs.com/package/bulletin-deploy)
and [`polkadot-app-deploy`](https://github.com/paritytech/polkadot-app-deploy).
