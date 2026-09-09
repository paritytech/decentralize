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
e2e/bootstrap.sh --register # the one real deploy that (re)claims decentralize-ci.paseo
```

## 1. `decentralize-ci.paseo`

> **Update, 2026-08-18:** the label's TLD changed. bulletin-deploy 0.15.0 made
> the TLD per-environment, and paseo-next-v2 (this suite's `ENV_ID`) registers
> under `.paseo`, not `.dot` — the name below was re-registered as
> `decentralize-ci.paseo` (see item 4's update for the full re-genesis story).
> Everywhere below that still says `.dot` in a command example is preserved
> as-written for history; the live, current name is `decentralize-ci.paseo`,
> and `decentralize` itself now forwards the bare label `decentralize-ci` and
> lets bulletin-deploy apply that suffix (see the main README's "Naming"
> section) — do not hand it `decentralize-ci.dot` directly, that now fails
> with `Domain "decentralize-ci.dot" ends in ".dot", but this environment
> uses ".paseo" names.`

**What it is:** a fixed DotNS label on Paseo Next v2, originally registered
2026-08-07 as `decentralize-ci.dot`, then re-registered 2026-08-18 as
`decentralize-ci.paseo` after the chain re-genesis described in item 4's
update (a re-genesis resets on-chain state, so the original registration did
not carry forward — this is the "How to recreate it if lost" path below,
exercised for real).

**Why it's needed:** the suite re-deploys over the same name every run rather
than minting a fresh one per run. That keeps on-chain state bounded (one
registration, ever) and exercises the overwrite path real users actually hit.
See the design doc's "Name strategy" section for the rationale against
fresh-name-per-run.

**Current owner:** `0x35Cdb23fF7fc86E8DCcd577CA309bFEA9c978D20`, i.e. the
built-in worker `5DfhGyQdFobKM8NsWvEeAKk5EQQgYe9AydgJ7rMB6E1EqRzV` — the
pool-fallback signer bulletin-deploy uses when no session and no
`--mnemonic` are supplied.

**Why it classifies as NoStatus (open to any account — see item 4's update
for why "NoStatus" no longer also means "free"):** from `classifyLabelStatus`
in the pinned bulletin-deploy:

| Label shape | Required status |
| --- | --- |
| 1 or 3+ trailing digits, or base length <= 5 | Reserved (unregistrable) |
| base length <= 8 | PoP Lite (2 trailing digits) / PoP Full (0) |
| **base length >= 9, exactly 0 or 2 trailing digits** | **NoStatus — open to any account** |

`decentralize-ci` has a 15-character base and ends in a letter, so it lands in
the last row: open to any account, not gated on the signer's PoP status.

> **Note, 2026-09-09 (see item 5's update of the same date for the full
> story):** the "1 or 3+ trailing digits ... Reserved" row above no longer
> reflects the DotNS profile live under the `bulletin-deploy@0.18.0` pin —
> that rule was dropped in DotNS v0.6.0. Left as-written since it does not
> change `decentralize-ci`'s own classification (0 trailing digits, base
> length 15 — the last row either way), and rewriting a table that's still
> correct for the row that matters here risked losing the historical shape
> of the rule for anyone auditing this document later.

**How to check it:** there is no supported non-deploying way to read this
label's current on-chain contenthash or owner — see "known unknown" below.
`e2e/bootstrap.sh` reports this row as `UNKNOWN, cannot check without
deploying` rather than fabricating a check. Treat that row as expected, not a
failure.

**How to recreate it if lost:** simply run a deploy against it. Any deploy —
the e2e suite's own run, `e2e/bootstrap.sh --register`, or a manual
`bulletin-deploy <dir> decentralize-ci --env paseo-next-v2` (bare label — see
the 2026-08-18 update above) — re-registers/overwrites it. There is no
separate "provisioning" step; deploying *is* the recovery mechanism.

**The sharp edge (accepted risk, not hidden):** ownership sits with
bulletin-deploy's **shared default dev worker**, not an account this project
controls. That worker is derived deterministically for *anyone* who runs
bulletin-deploy with no session and no `--mnemonic` against Paseo Next v2 —
it is not scoped to this repo or this CI. Concretely: anyone, anywhere,
running plain `bulletin-deploy <dir> decentralize-ci --env paseo-next-v2` with
no session would be the *same* signer/owner and could silently overwrite our
content.
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
decentralize-ci --env paseo-next-v2` — without realizing it would silently
move the name off the pool-fallback worker and onto their personal account.
That's worse than the stranger case above: it's not recoverable by re-running
`--register` from CI, because CI's pool worker no longer owns the name to
overwrite. `e2e/bootstrap.sh --register` checks `bulletin-deploy whoami` first
and refuses to run while a session is signed in, naming `bulletin-deploy
logout` as the remedy — but this check only covers this script's own
`--register` path, not a developer running bulletin-deploy directly by hand.
Log out before touching `decentralize-ci.paseo` directly.

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

> **Update, 2026-08-18 — this predicted failure mode happened.** Paseo Next
> v2 was re-genesised, and the pool-fallback worker
> (`5DfhGyQdFobKM8NsWvEeAKk5EQQgYe9AydgJ7rMB6E1EqRzV`) came back with **no PoP
> status at all**. `bulletin-deploy`'s preflight now reports `Your PoP:
> NoStatus` for it — exactly the "single most likely way the design silently
> stops working" scenario called out below, before it had actually happened.
> The section below is left as originally written (it is still an accurate
> description of *why* the suite used to cost nothing); read it as history,
> then read this update for the current state:
>
> - **Deploys are no longer free.** A live registration against
>   `decentralize-ci.paseo` reported `Oracle price: 10 PAS / Paying: 11 PAS`
>   — `registerDepositWei` now takes the `NoStatus` branch (`startingPriceWei`)
>   exactly as predicted. Separately, bulletin-deploy's preflight also prints
>   a balance-floor figure (observed: **211.1 PAS**) that the signer must hold
>   to proceed — that figure is a *minimum balance requirement*, not the
>   price of this deploy; don't confuse the two when reading its output.
> - **The worker was funded** to cover this: topped up via the public faucet
>   (<https://faucet.polkadot.io/?parachain=1500>) to **~5005 PAS**, at
>   `5DfhGyQdFobKM8NsWvEeAKk5EQQgYe9AydgJ7rMB6E1EqRzV` — the same address as
>   above. **That is the address to top up** if this suite ever starts
>   failing on a balance error again.
> - **The subtle trap: bulletin-deploy's own auto-top-up cannot rescue this
>   worker.** bulletin-deploy has a dev-convenience path that auto-tops-up a
>   low-balance signer from "Alice". That "Alice" is **the root account of
>   the dev mnemonic** (`//` with no derivation path) — and the pool-fallback
>   worker *is* that same root account, not `//Alice` (the well-known
>   `5GrwvaEF…` test account derived from it). The auto-top-up code compares
>   the source and recipient addresses and **skips the transfer whenever they
>   are equal** — so when the worker itself is the signer, "Alice" funding
>   the worker is a no-op by construction: the source and destination are the
>   same account. Funding the derived `//Alice` (`5GrwvaEF…`) does **nothing**
>   for this worker — do not waste a faucet request on it. Fund
>   `5DfhGyQdFobKM8NsWvEeAKk5EQQgYe9AydgJ7rMB6E1EqRzV` directly.
> - **Current registration:** `decentralize-ci.paseo` is registered and owned
>   by `0x35Cdb23fF7fc86E8DCcd577CA309bFEA9c978D20` (the same worker, EVM-mapped
>   — matches item 1's "Current owner").
>
> **What it was (history, before the re-genesis):** the pool-fallback signer
> (`5DfhGyQdFobKM8NsWvEeAKk5EQQgYe9AydgJ7rMB6E1EqRzV`) carried
> `ProofOfPersonhoodFull`.

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

## 5. Pinned `bulletin-deploy@0.18.0`

> **Update, 2026-08-18:** bumped from `0.14.2` to `0.15.0`
> (`deps/bulletin-deploy-0.15.0`). The section below still says `0.14.2` in
> places where it is describing that specific version's behaviour verbatim
> ("verified by hand against 0.14.2" etc.) — left as-written, since it is
> accurate history, not updated to imply it was re-verified against 0.15.0
> line-by-line. The one thing this bump changed that matters everywhere in
> this document: `assets/environments.json` gained a per-environment `tld`
> field, and `paseo-next-v2` (this suite's `ENV_ID`) now uses `.paseo` instead
> of `.dot` — see item 1's update and the main README's "Naming" section.

> **Update, 2026-09-07:** bumped from `0.15.0` to `0.17.0`
> (`deps/bulletin-deploy-0.17.0`). Motivation: the nightly e2e suite had been
> red every night since 2026-09-02, always with `Contract execution would
> revert during startingPrice on POP_RULES` on paseo-next-v2 — the DotNS
> contracts there were upgraded (ABI drift, `PopRules.startingPrice()`
> removed, pricing moved to a cost-model registry) and bulletin-deploy 0.16.1
> shipped the fix (protocol-version detection + per-version adapters). The
> section below still says `0.14.2` in places describing that specific
> version's behaviour verbatim — left as-written as accurate history, not
> updated to imply a line-by-line re-verification against every version in
> between. See the "What to re-verify on any version bump" checklist below;
> it was worked through again for this bump.
>
> **This bump also introduces a `latest` channel, separate from the pin.**
> `package.json` keeps the exact `0.17.0` pin — end users still get a
> known-good, reproducible version. But the nightly/on-demand workflow
> (`.github/workflows/e2e.yml`) additionally installs
> `bulletin-deploy@latest` on top of that pin before running, so upstream
> ABI drift like the one above is caught the night it lands rather than
> whenever someone next gets around to bumping the pin here. A new env var,
> `BULLETIN_DEPLOY_CHANNEL` (`latest` or unset/`pinned`), tells both
> `e2e/bootstrap.sh` and the vitest version banner (`e2e/bulletin-version.ts`)
> which mode a run is in:
>
> - **Nightly (scheduled) runs default to `latest`.** `check_bulletin_pin` in
>   `e2e/bootstrap.sh` treats installed-differs-from-declared as an expected,
>   **PASS**ing condition in this mode (worded as "running latest X, package.json
>   pins Y — in sync" or "— bump candidate"), not the WARN it would otherwise
>   be — a nightly that installs a newer bulletin-deploy on purpose should not
>   look like a misconfigured machine.
> - **A human can dispatch a `pinned` run** (`workflow_dispatch` input
>   `channel: pinned`) to discriminate an **upstream regression** (only
>   `latest` fails) from **chain drift** (both `latest` and `pinned` fail —
>   the deployed contracts changed under both) or **our own staleness** (only
>   `pinned` fails, because `latest` has already adapted upstream). In
>   `pinned` mode, `check_bulletin_pin`'s behaviour is completely unchanged
>   from before this bump: installed-differs-from-declared is still the
>   original **WARN**, with its full re-verification checklist.
> - Every vitest run — unit and e2e alike — prints a one-line banner at
>   start-up naming the installed version, the channel, and the package.json
>   pin (e.g. `▸ bulletin-deploy@0.17.0 (channel: latest; package.json pins
>   0.17.0)`), so a reader never has to dig through an `npm install` log to
>   know which bulletin-deploy a given run actually exercised.

> **Update, 2026-09-09:** bumped from `0.17.0` to `0.18.0`
> (`deps/bulletin-deploy-0.18.0`). Motivation: bulletin-deploy 0.18.0 ships
> DotNS v0.6.0 (upstream bulletin-deploy#1414, released 2026-09-07, live on
> previewnet and paseo-next-v2 — the environments this tool targets — within
> 24h of that release per the commit message), which **drops the
> trailing-digit rule entirely**: base length is now the label as written,
> and `PopRules._classifyValidatedName` no longer strips digits or treats 1
> or 3+ trailing digits as Reserved. `decentralize` had its own local copy of
> that now-dead rule (`assertLabelIsPopRulesSafe` in `src/index.ts`, refusing
> such labels before ever calling bulletin-deploy) — removed in this bump
> rather than updated, since pre-empting a chain-side rule locally is what
> let it rot the moment upstream changed it; see the main README's "Naming"
> section for the rewritten explanation and its history. **This also makes
> the `classifyLabelStatus` table in item 1 above stale for this pin**: its
> "1 or 3+ trailing digits, or base length <= 5 → Reserved" row no longer
> reflects the pinned bulletin-deploy's DotNS profile. `decentralize-ci`
> itself is unaffected either way — 0 trailing digits and a 15-character base
> classified it as NoStatus before this bump and still does after — so this
> is flagged for accuracy, not because the checklist item below actually
> flipped. The rest of item 5's re-verification checklist was worked through
> again for this bump: `fetchManifestRoundtrip`/`parseManifest` still resolve
> at the same paths, and the `startingPriceWei` price rule is unchanged.

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
   still keyed the same way. (This branch is no longer hypothetical: as of
   the 2026-08-18 update in item 4, the worker IS `NoStatus` and every run
   now pays `startingPriceWei` — observed as `Oracle price: 10 PAS / Paying:
   11 PAS`. Re-verify this rule's shape on the next bump precisely because a
   change here changes what the suite pays, not whether it pays at all.)
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

> **Update, 2026-08-18:** the trigger above fired — the worker's PoP status
> lapsed (item 4) and the suite now pays `~11 PAS` per run. The rule in this
> section still holds regardless: the fix was to **fund the worker directly**
> (item 4's faucet top-up to ~5005 PAS), not to add a `MNEMONIC` secret. "No
> secrets" was never a claim that deploys are free forever — it's a claim
> that this suite doesn't authenticate as anyone. It still doesn't.

## Known unknowns

Stated honestly rather than assumed away:

- **Whether DotNS registrations expire.** Not established. If they do, the
  window before `decentralize-ci.paseo` needs a fresh registration (as opposed
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
  what schedule.** Partially resolved, 2026-08-18: it can, and did — see item
  4's update. What's still unknown is the *schedule*: this instance was
  triggered by a chain re-genesis, not a natural expiry, so whether
  `ProofOfPersonhoodFull` also lapses on its own over time (independent of a
  re-genesis event) remains unestablished. Still not monitorable from outside
  a full deploy attempt (or a preflight-only run — see item 4's `Your PoP:
  NoStatus` observation, which came from bulletin-deploy's own preflight
  output, not a purpose-built check on our side).
