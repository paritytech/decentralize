# e2e bootstrap: dependency register and recovery runbook

This is the dependency register for the real-chain e2e suite (design:
`docs-internal/superpowers/specs/2026-08-10-e2e-chain-validation-design.md`).
For every external thing the suite leans on: what it is, why it's needed, how
to check it, how to get it back if it disappears, and what breaks if it does.

Run `e2e/bootstrap.sh` to check all of this mechanically. This file is the
explanation behind that script's output — read it when a check fails, or
before touching anything that could invalidate one of these assumptions.

This is a **testnet** setup for a non-blocking, on-demand e2e suite. Nothing
here is audited or hardened for production use.

## Quick check

```sh
e2e/bootstrap.sh            # check-only, read-only, never touches the chain
e2e/bootstrap.sh --fix      # additionally runs `ipfs init` if the repo is missing
e2e/bootstrap.sh --register # the one real deploy that (re)claims decentralize-ci.dot
```

## 1. `decentralize-ci.dot`

**What it is:** a fixed DotNS label on Paseo Next v2, registered 2026-08-07.

**Why it's needed:** the suite re-deploys over the same name every run rather
than minting a fresh one per run. That keeps on-chain state bounded (one
registration, ever) and exercises the overwrite path real users actually hit.
See the design doc's "Name strategy" section for the rationale against
fresh-name-per-run.

**Current owner:** `0x35Cdb23fF7fc86E8DCcd577CA309bFEA9c978D20`, i.e. the
built-in worker `5DfhGyQdFobKM8NsWvEeAKk5EQQgYe9AydgJ7rMB6E1EqRzV` — the
pool-fallback signer bulletin-deploy uses when no session and no
`--mnemonic` are supplied.

**Why it classifies as free (NoStatus):** from `classifyLabelStatus` in the
pinned bulletin-deploy:

| Label shape | Required status |
| --- | --- |
| 1 or 3+ trailing digits, or base length <= 5 | Reserved (unregistrable) |
| base length <= 8 | PoP Lite (2 trailing digits) / PoP Full (0) |
| **base length >= 9, exactly 0 or 2 trailing digits** | **NoStatus — open to any account** |

`decentralize-ci` has a 15-character base and ends in a letter, so it lands in
the last row: open to any account, not gated on the signer's PoP status.

**How to check it:** there is no supported non-deploying way to read this
label's current on-chain contenthash or owner — see "known unknown" below.
`e2e/bootstrap.sh` reports this row as `UNKNOWN, cannot check without
deploying` rather than fabricating a check. Treat that row as expected, not a
failure.

**How to recreate it if lost:** simply run a deploy against it. Any deploy —
the e2e suite's own run, `e2e/bootstrap.sh --register`, or a manual
`bulletin-deploy <dir> decentralize-ci.dot` — re-registers/overwrites it. There
is no separate "provisioning" step; deploying *is* the recovery mechanism.

**The sharp edge (accepted risk, not hidden):** ownership sits with
bulletin-deploy's **shared default dev worker**, not an account this project
controls. That worker is derived deterministically for *anyone* who runs
bulletin-deploy with no session and no `--mnemonic` against Paseo Next v2 —
it is not scoped to this repo or this CI. Concretely: anyone, anywhere,
running plain `bulletin-deploy <dir> decentralize-ci.dot` with no session
would be the *same* signer/owner and could silently overwrite our content.
There is no ownership check we can add on our side to prevent this — the
worker's identity is bulletin-deploy's, not ours. This is a real, accepted
risk given the suite's scope (one disposable testnet fixture, not a
production asset): document it, don't work around it. If this ever surfaces
as an actual collision (someone else's content shows up in our manifest
assertion), that is the expected failure mode, not chain corruption — re-run
`--register` to reclaim it.

**What breaks if it disappears (deregisters/expires):** the suite's deploy
step would go through DotNS's *registration* path instead of the *overwrite*
path for one run. That's not fatal — bulletin-deploy handles both — but it
changes what's being exercised for that run (see "known unknown" below on
whether this can even happen).

**The mirror-image sharp edge (a human, not a stranger, can also take it
away):** bulletin-deploy's *default* behaviour, when the invoking machine has
an active `bulletin-deploy login` session, is to register with the local
worker and then **transfer the name to the signed-in account** with zero
mobile signatures (`--no-transfer-to-signedin-user` is the opt-out — see
`bulletin-deploy --help`). A developer who is signed in on their own machine
and runs `e2e/bootstrap.sh --register` — or any bare `bulletin-deploy <dir>
decentralize-ci.dot` — without realizing it would silently move the name off
the pool-fallback worker and onto their personal account. That's worse than
the stranger case above: it's not recoverable by re-running `--register`
from CI, because CI's pool worker no longer owns the name to overwrite.
`e2e/bootstrap.sh --register` checks `bulletin-deploy whoami` first and
refuses to run while a session is signed in, naming `bulletin-deploy logout`
as the remedy — but this check only covers this script's own `--register`
path, not a developer running bulletin-deploy directly by hand. Log out
before touching `decentralize-ci.dot` directly.

## 2. Kubo (`ipfs` binary + initialized repo)

**What it is:** the IPFS Kubo binary, on `PATH`, with an **initialized
repo** (`ipfs init` has been run).

**Why it's needed, and why two things not one:** `decentralize`'s own
preflight only checks that `ipfs` resolves on `PATH` (`onPath("ipfs")` in
`src/cli.ts`) — that's the right check for what it protects (refusing to
silently fall back to the pure-JS merkleizer, which has historically produced
un-walkable CARs). But `ipfs` being *on PATH* and `ipfs` having a *usable
repo* are different facts. A fresh `HOME` — exactly the state of a new CI
runner — has the binary but no repo, and bulletin-deploy's merkleization step
dies here:

```
Error: no IPFS repo found in <HOME>/.ipfs.
please run: 'ipfs init'
```

This is bulletin-deploy's requirement, one layer below `decentralize`'s own
preflight. `decentralize` itself doesn't know or care whether the repo is
initialized; bulletin-deploy does, and finds out the hard way if it isn't.

**How to check it:** `ipfs repo stat` — succeeds if the repo (default
`$HOME/.ipfs`, or `$IPFS_PATH` if set) exists, fails with the message above
otherwise. `e2e/bootstrap.sh` uses exactly this command rather than guessing
at which files should exist inside the repo directory.

**How to recreate it:** `ipfs init` (respects `$IPFS_PATH`). This is the one
remediation `e2e/bootstrap.sh --fix` performs automatically — it is local,
idempotent, and has no on-chain or off-machine effect.

**What breaks if it disappears:** every deploy in every run fails at
merkleization. Loud, not silent — this is not the CAR-correctness failure
mode the README warns about; it's a hard preflight-adjacent error.

## 3. Paseo Next v2 endpoints

**What they are:**

- RPC: `wss://paseo-bulletin-next-rpc.polkadot.io`
- IPFS gateway: `https://paseo-bulletin-next-ipfs.polkadot.io`

**Why they're needed:** the RPC is where the actual DotNS/Bulletin chain
calls land; the gateway is where the suite fetches back the deployed
contenthash to assert against (see "manifest exports" below — the assertion
reads through the gateway, not the RPC).

**Outside our control:** both are Parity-operated public testnet endpoints.
Neither can be pinned, load-balanced, or guaranteed available by this repo.
A gateway or RPC outage is expected occasionally and is exactly why the
design makes this suite non-blocking (nightly + `workflow_dispatch`, never a
required check).

**Read from the environment where practical:** rather than hardcoding the
gateway at call sites, read it from bulletin-deploy's own environments doc.
Note that the exported `listEnvironments()` helper returns a *summary*
listing (`id`, `name`, `network`, `hasBulletin`, `description` — no `ipfs`
field); the gateway lives on the full environment record:

```js
const { loadEnvironments } = await import("bulletin-deploy");
const { doc } = await loadEnvironments();
const env = doc.environments.find((e) => e.id === "paseo-next-v2");
env.ipfs; // -> "https://paseo-bulletin-next-ipfs.polkadot.io"
```

Verified by hand against 0.14.2. `e2e/bootstrap.sh` takes a simpler path to
the same data — reading `node_modules/bulletin-deploy/assets/environments.json`
directly rather than going through `loadEnvironments()` — with a hardcoded
fallback only if that lookup fails, so the check itself doesn't depend on
async chain-adjacent machinery just to find a URL string.

**How to check reachability:** a short-timeout HTTP GET against the gateway.
Any HTTP response (even 404 — the gateway's root path with no CID isn't
expected to serve anything) counts as "reachable"; a timeout or connection
failure doesn't. This is a liveness check only, not a content check.

**Note this only covers the gateway, not the RPC.** `e2e/bootstrap.sh` has no
check for `wss://paseo-bulletin-next-rpc.polkadot.io` reachability —
probing a websocket RPC meaningfully (open a connection, wait for a
subscription, tear it down cleanly) is materially more machinery than an
HTTP GET, and edges toward the same "not actually lightweight" territory as
the on-chain contenthash read in the known-unknowns section below. If the
RPC is down, the checks above will still report all-green and the first
real signal will be the e2e suite's own deploy step failing or timing out —
which the design's failure reporting already handles by naming which link
in the chain broke.

**What breaks if unreachable:** the deploy step itself can still succeed (it
talks to the RPC, not the gateway) but the suite's manifest-roundtrip
assertion (step 5 of the design's assertion chain) will fail or time out —
reported distinctly from a real regression, per the design's failure
reporting section.

## 4. The worker's `ProofOfPersonhoodFull` status

**What it is:** the pool-fallback signer (`5DfhGyQdFobKM8NsWvEeAKk5EQQgYe9AydgJ7rMB6E1EqRzV`)
currently carries `ProofOfPersonhoodFull`.

**Why this is the whole reason the suite costs nothing:** the price rule
lives in the pinned bulletin-deploy and keys on the **signer's** status, not
the label's:

```js
function registerDepositWei(userStatus, startingPriceWei) {
  return userStatus === ProofOfPersonhoodStatus.NoStatus ? startingPriceWei : 0n;
}
```

`decentralize-ci` classifies as a NoStatus-eligible label (any account may
register/overwrite it), but the *price* charged still depends on what status
the *signer* holds. A `NoStatus` signer would be charged `startingPriceWei`.
The worker currently holds `ProofOfPersonhoodFull`, so the branch above
evaluates to `0n` — that is the entire reason this suite runs with no
secret, no funded account, and no faucet step.

**This is the single most likely way the design silently stops working.**
If the worker's PoP status ever lapses (expires, gets revoked, or the
worker's derivation changes upstream in bulletin-deploy), this same code path
starts charging `startingPriceWei` per run, and every subsequent nightly run
would fail — not with an obvious "your PoP expired" error necessarily, but
with a payment/balance failure from an account that was never provisioned to
pay anything, on every single run from then on. **If this happens, the
suite needs a funded account** (or the whole premise needs re-examining) —
that is a design escalation, not a one-line fix.

**How to check it today:** `e2e/bootstrap.sh` does **not** check this (it
would require the same non-trivial chain read discussed under "known
unknowns" below, and PoP status specifically requires a signer-scoped query).
If nightly runs start failing on a price/balance error where they previously
didn't, check this first, before assuming a `decentralize` or
`bulletin-deploy` regression.

## 5. Pinned `bulletin-deploy@0.14.2`

**What it is:** `decentralize`'s own pinned dependency (`package.json` →
`dependencies.bulletin-deploy`), and the two public exports the e2e suite
uses:

- `fetchManifestRoundtrip` from `bulletin-deploy/manifest-roundtrip`
- `parseManifest` from the `bulletin-deploy` root export

**Why pinned, and why these two specifically:** `decentralize`'s CLI already
refuses to use an unpinned copy of bulletin-deploy on `PATH` (an unpinned
version can silently retarget a deploy — see the main README's "Naming"
section). The e2e suite inherits that same caution for its own direct
dependency use. `fetchManifestRoundtrip` and `parseManifest` are, as of
0.14.2, the *only* manifest helpers bulletin-deploy exports publicly — a
deliberate choice of the supported surface over reaching into
`bulletin-deploy`'s internals, because the public surface is the one least
likely to break silently under a version bump, and if it does break, that
break is itself a signal worth failing loudly on rather than working around.

**How to check it:** `e2e/bootstrap.sh` compares the version installed in
`node_modules/bulletin-deploy/package.json` against the value pinned in this
repo's `package.json`. A mismatch is a **warning**, not a hard failure — it
usually just means `npm install` hasn't been re-run — but it's flagged
because a silent version drift is exactly the kind of thing this project
already knows can matter (see the README's "Pinned dependency" section for
the historical incident with unpinned `bulletin-deploy` rewriting labels).
Separately, a tiny `node -e` import check resolves both exports directly and
fails loudly if either is missing or renamed.

**What to re-verify on any version bump** (whether intentional, or flagged as
a mismatch by the check above):

1. The `classifyLabelStatus` table above still classifies `decentralize-ci`
   as NoStatus (a change to trailing-digit or base-length rules could flip
   this).
2. `fetchManifestRoundtrip` and `parseManifest` still exist at the same
   import paths with compatible signatures — the check above catches this
   directly.
3. The price rule (`userStatus === NoStatus ? startingPriceWei : 0n`) is
   still keyed the same way — a change here could reintroduce a cost where
   today there is none.
4. The CAR-vs-manifest relationship in the design doc ("The on-chain
   contenthash is the CAR, not the UnixFS directory") still holds — this is
   what the whole assertion chain in the design depends on.

## 6. No secrets

**The rule:** this suite must never require a secret — no `MNEMONIC`, no
login/session, no repo secret of any kind. The entire point of the spike that
produced the design doc was confirming the pool-fallback signer needs none of
these.

**If this ever changes:** if a future run genuinely needs `MNEMONIC` or a
login to succeed, **that is a design break to escalate, not a gap to
quietly patch over** by adding a repo secret. The most likely trigger is
item 4 above (the worker's PoP status lapsing) turning a free deploy into a
paid one. Do not add `MNEMONIC` to CI as a workaround without first
confirming whether the free-deploy premise still holds at all — a secret
papering over a broken premise just hides the regression instead of
surfacing it.

## Known unknowns

Stated honestly rather than assumed away:

- **Whether DotNS registrations expire.** Not established. If they do, the
  window before `decentralize-ci.dot` needs a fresh registration (as opposed
  to an overwrite of an existing one) is unknown. Both paths are handled by
  bulletin-deploy either way (see item 1's "how to recreate"), so this
  doesn't block the suite — it's flagged so nobody mistakes a
  registration-path run for a bug later.
- **No supported non-deploying way to read a label's current on-chain
  contenthash or owner.** We looked: bulletin-deploy's `DotNS` class (the
  only exported type with relevant methods, `checkOwnership` /
  `getContenthash`) is exported from the package root, but `connect()` is
  not a lightweight read — it drives full pool-account derivation and EVM
  address auto-mapping (`ReviveApi.address`) as part of establishing the
  connection. Tried by hand: it actually failed outright on this machine
  with `Runtime entry RuntimeCall(ReviveApi_address) not found` before ever
  reaching `getContenthash`. That's not a lightweight, side-effect-free
  read — it's machinery adjacent to the deploy path itself, and it can fail
  for reasons unrelated to whether the label needs reclaiming. We chose not
  to build a check on top of something that unreliable. `e2e/bootstrap.sh`
  reports this row honestly as `UNKNOWN, cannot check without deploying`. If
  bulletin-deploy ever exposes a genuinely lightweight read-only query for
  this, revisit.
- **Whether the worker's `ProofOfPersonhoodFull` status can lapse, and on
  what schedule.** Not established — see item 4. Worth monitoring, not
  currently monitorable from outside a full deploy attempt.
