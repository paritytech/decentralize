# Real-chain e2e validation for `decentralize`

**Status:** approved design, not yet implemented
**Date:** 2026-08-10

## Problem

`decentralize`'s existing suite (51 tests across `src/index.test.ts` and
`src/cli.test.ts`) stops at a stub. `cli.test.ts` substitutes a fake binary via
`BULLETIN_DEPLOY_BIN` and asserts the argv handed to it. That is the right unit
boundary and it should stay — but it means nothing below the handoff is covered:
not the real merkleizer, not the real `bulletin-deploy`, not the chain.

The gap matters because of a failure mode the README already documents: a bad CAR
**succeeds**. The deploy reports success and the site then serves 404s. A test
that asserts `exit 0` would pass through exactly the bug we most need to catch.

## Scope

One real deploy to Paseo Next v2 per run, asserted by round-tripping the on-chain
contenthash back to the exact bytes that were staged.

Explicitly out of scope: mocked-chain tests, alternative environments, and any
attempt to make this gate pull requests.

## Empirical findings

Everything below was verified by hand on 2026-08-07 before this design was
written. These are observations, not assumptions.

### The default signer needs no secret and no funding

Run with a throwaway `HOME` so no session exists — the CI case:

```
Storage signer: pool fallback (no session)
SS58 Address:   5DfhGyQdFobKM8NsWvEeAKk5EQQgYe9AydgJ7rMB6E1EqRzV
Account:        auto-mapped (Revive.OriginalAccount confirmed)
DotNS:          decentralize-ci.dot requires NoStatus
Your PoP:       ProofOfPersonhoodFull
Domain:         available
Oracle price:   0 PAS
Paying:         0 PAS
```

This was the one blocking question, because the price rule keys on the *signer's*
status, not the label's:

```js
return userStatus === ProofOfPersonhoodStatus.NoStatus ? startingPriceWei : 0n;
```

A NoStatus signer would have to pay. The built-in worker carries
`ProofOfPersonhoodFull`, so it pays nothing. No repo secret, no faucet, no
`--mnemonic`.

### CI needs `ipfs init`, not just an `ipfs` binary

The first spike died here, with Kubo installed and on `PATH`:

```
Error: no IPFS repo found in <HOME>/.ipfs.
please run: 'ipfs init'
```

`decentralize`'s own preflight only checks that `ipfs` resolves on `PATH`
(`onPath("ipfs")`), which is the correct check for its purposes — the repo is
bulletin-deploy's requirement, one layer down. A fresh GitHub runner is exactly
the throwaway-HOME case. The workflow must run `ipfs init` explicitly.

### What a NoStatus label actually is

From `classifyLabelStatus` in the pinned bulletin-deploy:

| Label shape | Required status |
| --- | --- |
| 1 or 3+ trailing digits, or base length <= 5 | Reserved (unregistrable) |
| base length <= 8 | PoP Lite (2 trailing digits) / PoP Full (0) |
| **base length >= 9, exactly 0 or 2 trailing digits** | **NoStatus — open to any account** |

`decentralize-ci` has a 15-character base and ends in a letter, so it qualifies.

### The on-chain contenthash is the CAR, not the UnixFS directory

This is the finding that determines the whole assertion strategy, and it is
counter-intuitive enough to state plainly.

Fetching the deployed contenthash from the environment's IPFS gateway does **not**
give a browsable directory:

```
GET https://paseo-bulletin-next-ipfs.polkadot.io/ipfs/<contenthash>/index.html
  -> 404: no link named "index.html" under <contenthash>
```

The contenthash addresses the **CAR blob**. Fetching it without a subpath returns
CAR bytes, which embed `.bulletin-deploy/manifest.json`:

```json
{
  "version": 3,
  "files": {
    "index.html": {
      "cid": "bafkreiawh2ykql4u7wiies676is2czi3odmdsktjccztxbbkqiiyvhtrmq",
      "type": "volatile",
      "size": 131
    }
  }
}
```

That manifest is the machine-checkable record of what landed. Note also that a
local `ipfs add -r` of the source directory does **not** reproduce the deployed
root CID, because bulletin-deploy injects the manifest into the archive before
merkleizing. Directory-level CID comparison is therefore not a valid assertion.
Per-file CIDs are stable and do match.

### The name URL serves the host shell, not the content

```
GET https://decentralize-ci.paseo.li  ->  200, 20414 bytes
```

The body is the Polkadot host page (`<title>Polkadot - The decentral…`), not the
fixture. This is consistent with the README's account of the sandbox: the host
frames the app and the sandbox scrubs its own query string. Asserting on this
response body would be asserting on Parity's host page.

**The suite must not assert on the name URL's body.** A liveness check (HTTP 200)
is acceptable; a content check is not. This is recorded here so it is not
"fixed" later by someone who assumes it was an oversight.

## Design

### Name strategy: one fixed name, overwritten

`decentralize-ci.dot` is registered and owned by the worker account
`0x35Cdb23fF7fc86E8DCcd577CA309bFEA9c978D20` as of the spike. Every subsequent
run re-deploys over it.

Rationale: bounded on-chain state (one registration, ever), and it exercises the
overwrite path that real repeat users actually hit. Fresh-name-per-run was
rejected: it produces an unbounded stream of registrations and never covers
overwrite.

Consequence: two concurrent runs would race on one name, so the workflow needs a
`concurrency` group with `cancel-in-progress: false`.

### The assertion chain

Exit code alone is not an assertion. The suite performs:

1. **Generate a fixture with a run-unique marker** — git SHA plus run number
   embedded in `index.html`. A cached, stale, or accidentally-reused result
   cannot satisfy the later CID comparison.
2. **Compute the expected CID locally**, with the same flags bulletin-deploy uses:
   `ipfs add -Q --cid-version=1 --raw-leaves --pin=false index.html`
3. **Deploy** and capture stdout. Assert exit 0.
4. **Scrape `Verified on-chain: <contenthash>`** from the output.
5. **Fetch that contenthash** and extract the embedded
   `.bulletin-deploy/manifest.json`. Use bulletin-deploy's own public API rather
   than hand-parsing CAR bytes:

   ```ts
   import { fetchManifestRoundtrip } from "bulletin-deploy/manifest-roundtrip";
   import { parseManifest } from "bulletin-deploy";
   ```

   `fetchManifestRoundtrip(cid, { gateway, budgetMs })` polls the gateway within a
   budget and returns either `{ ok: true, manifestBytes }` or
   `{ ok: false, reason }`, which absorbs gateway propagation delay and yields a
   usable diagnostic when it does not. Gateway comes from the environment's
   `ipfs` field (`https://paseo-bulletin-next-ipfs.polkadot.io` for
   paseo-next-v2), not hardcoded at the call site.

   This is a deliberate choice of the supported seam over a private one: these
   are the only manifest helpers bulletin-deploy exports publicly, so they are
   the surface least likely to break under a version bump — and if they do
   break, that is itself a signal worth failing on.
6. **Assert** `files["index.html"].cid` equals the locally computed CID, and
   `files["index.html"].size` equals the fixture's byte length.

Step 6 is the point of spending a real deploy: it proves the bytes staged are the
bytes the chain now points at. Verified by hand during the spike — local
`bafkreiawh2y…` / 131 bytes matched the deployed manifest exactly.

### Archive-shape assertion

The same manifest is asserted to contain **exactly** `index.html` — no
`404.html`, no `_redirects`. This is a permanent regression guard on the default
changed in PR #1, where a byte-identical `404.html` doubled the on-chain chunk
count. Related: bulletin-deploy#1233.

A second case runs with `--fallback` and asserts all three files are present, so
the opt-in path is covered too.

### Trigger

`workflow_dispatch` plus a nightly `schedule`. **Never a required check.**

Two finalized chain transactions against a public RPC, with 60-second
finalization budgets and roughly two minutes of wall time, cannot gate pull
requests without making merges hostage to testnet weather. `Unit Tests` remains
the sole required check on `main`; PR authors get e2e as an on-demand button.

### Placement and isolation

- New top-level `e2e/` directory.
- `vitest.config.ts` keeps `include: ["src/**/*.test.ts"]` untouched, so
  `npm test` stays hermetic and offline. A PR run must never reach the chain.
- A separate `npm run test:e2e` with its own vitest config pointed at `e2e/`.
- Per-test timeout of at least 300s; the deploy alone is ~2 minutes.

### Failure reporting

Because the suite is non-blocking, a failure must be loud in the run summary
rather than a silent red square. Each assertion failure reports which link in the
chain broke — deploy failed, contenthash not found in output, gateway fetch
failed, manifest mismatch — so a testnet outage is distinguishable at a glance
from a real regression in `decentralize`.

Network flake is expected and is not worth a retry loop: a nightly cadence means
a transient failure self-heals, and retries would mask the RPC degradation that
is itself worth seeing.

## Prerequisites for the workflow

- Kubo installed on the runner, **and `ipfs init` run**.
- Node 22, `npm ci`, `npm run build` (the e2e suite drives the built CLI, matching
  what users install).
- No secrets. `permissions: contents: read`.

## Session isolation (discovered after this design was written)

Not known when the above was drafted; found while implementing the suite, and
recorded here because it is exactly the kind of thing a future reader would
otherwise "clean up" by mistake.

bulletin-deploy's default behaviour, **when a login session exists on the
invoking machine**, is: a local worker registers and deploys, then
**transfers the name to the signed-in account** — zero mobile signatures
required, `--no-transfer-to-signedin-user` is the opt-out. This design's whole
overwrite-path story depends on `decentralize-ci.dot` staying owned by the
shared pool-fallback worker (`0x35Cdb23fF7fc86E8DCcd577CA309bFEA9c978D20`)
forever, so every subsequent run can overwrite it (see "Name strategy" above).

If this suite ever ran on a machine with an active `bulletin-deploy login`
session — a developer's laptop is the realistic case, since CI runners never
have one — the deploy would silently and **permanently** move the name onto
that human's personal account. That is worse than an ordinary test failure:
it is not recoverable by re-running anything from CI, because CI's
pool-fallback worker would no longer own the name to overwrite.

**The fix:** the suite runs the deploy with the child process's `HOME` pointed
at a fresh, throwaway temp directory. bulletin-deploy resolves its session
store from `os.homedir()/.polkadot-apps`, and Node's `os.homedir()` resolves
from `$HOME` — so a throwaway `HOME` guarantees no session is visible to the
child, regardless of what is signed in on the host machine. This is exactly
the state this design's spike itself was validated under: with a throwaway
`HOME`, `whoami` reported "Not logged in" and the deploy took the
pool-fallback path at 0 PAS.

**The corollary that almost broke this a second way:** a throwaway `HOME`
also hides the real IPFS repo (`~/.ipfs` lives under `HOME` too), and
bulletin-deploy's merkleization step dies without one — this is the same "no
IPFS repo found" failure that killed the first spike (see "CI needs `ipfs
init`" above), except self-inflicted by the isolation fix instead of by a
fresh runner. The remedy is the same shape: resolve the real `IPFS_PATH` from
the ambient environment (respecting an already-set `$IPFS_PATH`, else
`$HOME/.ipfs`) **before** overriding `HOME`, and pass it through to the child
explicitly. Verified working end to end: a throwaway `HOME` plus an explicit
`IPFS_PATH` pointed at the real, already-initialized repo reaches
merkleization and the chain write normally.

This is implemented once, in `e2e/deploy.e2e.test.ts`'s `runDeploy` — see its
doc comment for the full explanation kept next to the code. `e2e/bootstrap.sh`
carries the mirror-image guard for its own `--register` path (refusing to run
while a session is signed in, rather than isolating it away), documented in
`e2e/BOOTSTRAP.md` item 1.

## Open questions

None. The spike settled signer, funding, label class, gateway semantics, and the
manifest format.
