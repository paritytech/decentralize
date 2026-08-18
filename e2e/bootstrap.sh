#!/usr/bin/env bash
# Copyright (C) Parity Technologies (UK) Ltd.
# SPDX-License-Identifier: GPL-3.0-or-later
#
# This program is free software: you can redistribute it and/or modify
# it under the terms of the GNU General Public License as published by
# the Free Software Foundation, either version 3 of the License, or
# (at your option) any later version.
#
# This program is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
# GNU General Public License for more details.
#
# You should have received a copy of the GNU General Public License
# along with this program. If not, see <https://www.gnu.org/licenses/>.

# bootstrap.sh — gets a machine (laptop or fresh CI runner) into a state
# where the e2e/ suite can run, and tells you exactly what is missing when
# it can't. See e2e/BOOTSTRAP.md for the full explanation of every check.
#
# Written for bash 3.2 (macOS's shipped /bin/bash) as well as bash 4/5 on
# Linux runners: no associative arrays, no `${var,,}`, no `mapfile`.
#
# Modes:
#   (no flags)   Check-only, READ-ONLY. Never deploys, never touches the
#                chain. Prints a pass/fail table and exits non-zero if any
#                required check fails.
#   --fix        Also remediates what is safe and local: runs `ipfs init`
#                if the IPFS repo is missing. Nothing else. Does NOT
#                register a name and does NOT deploy.
#   --register   Performs the ONE real on-chain deploy that (re)claims
#                decentralize-ci.paseo on Paseo Next v2. Prints exactly what
#                it is about to do, then asks for confirmation unless --yes
#                is also given. Refuses to run if any required check above
#                it is failing.
#   --yes        Skip the interactive confirmation for --register.
#   -h, --help   This message.
#
# Exit codes: 0 = all required checks passed (or --register succeeded).
#             1 = a required check failed, or --register was aborted/failed.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

DOT_LABEL="decentralize-ci"
ENV_ID="paseo-next-v2"
DEFAULT_GATEWAY="https://paseo-bulletin-next-ipfs.polkadot.io"

FIX=0
REGISTER=0
ASSUME_YES=0

# Parallel arrays (bash 3.2 has no associative arrays): one row per check.
CHECK_NAMES=()
CHECK_STATUS=()
CHECK_DETAIL=()

record_result() {
    CHECK_NAMES+=("$1")
    CHECK_STATUS+=("$2")
    CHECK_DETAIL+=("$3")
}

usage() {
    cat <<'USAGE'
Usage: e2e/bootstrap.sh [--fix] [--register [--yes]] [-h|--help]

  (no flags)   Check-only, read-only. Never deploys. Exits non-zero if a
               required dependency is missing.
  --fix        Run `ipfs init` if the IPFS repo is missing. The only
               remediation this script performs automatically.
  --register   Perform the one real deploy that (re)claims
               decentralize-ci.paseo on Paseo Next v2. Confirms interactively
               unless --yes is also passed.
  --yes        Skip the --register confirmation prompt.

See e2e/BOOTSTRAP.md for what each check verifies and how to recover by hand.
USAGE
}

parse_args() {
    while [ "$#" -gt 0 ]; do
        case "$1" in
            --fix) FIX=1 ;;
            --register) REGISTER=1 ;;
            --yes) ASSUME_YES=1 ;;
            -h | --help)
                usage
                exit 0
                ;;
            *)
                echo "Unknown argument: $1" >&2
                usage
                exit 1
                ;;
        esac
        shift
    done
}

# --- individual checks -------------------------------------------------

check_node() {
    if ! command -v node >/dev/null 2>&1; then
        record_result "Node.js" "FAIL" "not found on PATH — install Node.js >= 22 (see package.json engines.node)."
        return
    fi
    local required required_major actual_major actual_full
    required=$(node -e "process.stdout.write((require(process.argv[1]).engines || {}).node || '')" "$REPO_ROOT/package.json" 2>/dev/null || echo "")
    required_major=$(printf '%s' "$required" | grep -o '[0-9]\+' | head -1 || echo "")
    actual_full=$(node -e "process.stdout.write(process.version)" 2>/dev/null || echo "unknown")
    actual_major=$(node -e "process.stdout.write(process.versions.node.split('.')[0])" 2>/dev/null || echo "0")
    if [ -z "$required_major" ]; then
        record_result "Node.js" "WARN" "could not read engines.node from package.json; found ${actual_full}."
        return
    fi
    if [ "$actual_major" -ge "$required_major" ]; then
        record_result "Node.js" "PASS" "${actual_full} (package.json requires ${required})"
    else
        record_result "Node.js" "FAIL" "${actual_full} found, package.json requires ${required} — install a newer Node (nvm/volta/asdf) and re-run."
    fi
}

check_ipfs_binary() {
    if ! command -v ipfs >/dev/null 2>&1; then
        record_result "Kubo (ipfs binary)" "FAIL" "not found on PATH — install it: brew install ipfs (macOS) or see https://docs.ipfs.tech/install/command-line/ (Linux runners)."
        return
    fi
    local ver
    ver=$(ipfs version --number 2>/dev/null || echo "unknown")
    record_result "Kubo (ipfs binary)" "PASS" "v${ver} at $(command -v ipfs)"
}

check_ipfs_repo() {
    local repo_path="${IPFS_PATH:-$HOME/.ipfs}"
    if ! command -v ipfs >/dev/null 2>&1; then
        record_result "IPFS repo initialized" "FAIL" "cannot check — ipfs binary missing (see above)."
        return
    fi
    local stat_err
    if stat_err=$(ipfs repo stat 2>&1 1>/dev/null); then
        record_result "IPFS repo initialized" "PASS" "repo present at ${repo_path}"
        return
    fi
    # `ipfs repo stat` fails for more than one reason — "no repo found" (the
    # fresh-HOME case this script exists to catch) is only one of them; a
    # repo that exists but needs an `ipfs repo migrate` after a Kubo upgrade
    # fails here too, and "run ipfs init" would be the wrong remedy for that.
    # Distinguish instead of assuming.
    if ! printf '%s' "$stat_err" | grep -qi "no ipfs repo found"; then
        record_result "IPFS repo initialized" "FAIL" "'ipfs repo stat' failed for a reason other than a missing repo — likely needs 'ipfs repo migrate' after a Kubo upgrade. Raw error: ${stat_err}"
        return
    fi
    if [ "$FIX" -eq 1 ]; then
        echo "  --fix: no repo at ${repo_path} — running 'ipfs init'..." >&2
        if ipfs init >/dev/null 2>&1; then
            record_result "IPFS repo initialized" "PASS" "created at ${repo_path} via --fix"
        else
            record_result "IPFS repo initialized" "FAIL" "'ipfs init' failed — run it by hand: IPFS_PATH=${repo_path} ipfs init"
        fi
    else
        record_result "IPFS repo initialized" "FAIL" "no repo at ${repo_path} — deploy dies at merkleization without one. Run 'ipfs init', or re-run this script with --fix."
    fi
}

check_bulletin_pin() {
    local declared
    declared=$(node -e "
      const p = require(process.argv[1]);
      process.stdout.write((p.dependencies && p.dependencies['bulletin-deploy']) || '');
    " "$REPO_ROOT/package.json" 2>/dev/null || echo "")
    if [ -z "$declared" ]; then
        record_result "bulletin-deploy pin (package.json)" "FAIL" "no bulletin-deploy dependency declared in package.json — this repo is broken, not your machine."
        return
    fi
    if [ ! -f "$REPO_ROOT/node_modules/bulletin-deploy/package.json" ]; then
        record_result "bulletin-deploy installed" "FAIL" "package.json pins ${declared} but it is not installed — run 'npm install' (or 'npm ci') in ${REPO_ROOT}."
        return
    fi
    local installed declared_stripped
    installed=$(node -e "process.stdout.write(require(process.argv[1]).version)" "$REPO_ROOT/node_modules/bulletin-deploy/package.json" 2>/dev/null || echo "unknown")
    declared_stripped=$(printf '%s' "$declared" | sed 's/^[\^~]//')
    if [ "$declared_stripped" = "$installed" ]; then
        record_result "bulletin-deploy pin" "PASS" "installed ${installed} matches package.json (${declared})"
    else
        record_result "bulletin-deploy pin" "WARN" "installed ${installed} != package.json's ${declared} — run 'npm install' to sync. If the pin was deliberately bumped, re-verify (see e2e/BOOTSTRAP.md 'version bump' section): the classifyLabelStatus table for decentralize-ci, the manifest export check below, and the price rule (userStatus === NoStatus ? startingPriceWei : 0n)."
    fi
}

check_manifest_exports() {
    if [ ! -d "$REPO_ROOT/node_modules/bulletin-deploy" ]; then
        record_result "bulletin-deploy manifest exports" "FAIL" "cannot check — bulletin-deploy not installed (see above)."
        return
    fi
    # Note: importing bulletin-deploy's root module can print a harmless
    # stderr warning (e.g. `--localstorage-file`); only stdout is checked
    # for the "ok" marker so that warning never causes a false FAIL.
    local js out err
    js="
      Promise.all([
        import('bulletin-deploy/manifest-roundtrip'),
        import('bulletin-deploy'),
      ]).then(([roundtrip, root]) => {
        if (typeof roundtrip.fetchManifestRoundtrip !== 'function') throw new Error('fetchManifestRoundtrip is not exported from bulletin-deploy/manifest-roundtrip');
        if (typeof root.parseManifest !== 'function') throw new Error('parseManifest is not exported from bulletin-deploy root');
        process.stdout.write('ok');
      }).catch((e) => { console.error(e.message); process.exitCode = 1; });
    "
    # `if out=$(...)` (rather than a bare assignment) keeps this safe under
    # `set -e`: a failing command substitution as an if-condition does not
    # trigger errexit, whereas a bare `out=$(...)` statement would abort the
    # whole script before the else branch below ever ran.
    if out=$(cd "$REPO_ROOT" && node -e "$js" 2>/dev/null) && [ "$out" = "ok" ]; then
        record_result "bulletin-deploy manifest exports" "PASS" "fetchManifestRoundtrip + parseManifest both resolve"
    else
        err=$(cd "$REPO_ROOT" && node -e "$js" 2>&1 1>/dev/null || true)
        record_result "bulletin-deploy manifest exports" "FAIL" "import failed: ${err} — likely an incompatible bulletin-deploy version bump; see e2e/BOOTSTRAP.md."
    fi
}

check_gateway() {
    if ! command -v curl >/dev/null 2>&1; then
        record_result "IPFS gateway reachable" "FAIL" "cannot check — curl not found on PATH. Install curl, or check the gateway by hand: see e2e/BOOTSTRAP.md."
        return
    fi
    local gateway
    gateway=$(cd "$REPO_ROOT" && node -e "
      try {
        const e = require('./node_modules/bulletin-deploy/assets/environments.json');
        const env = (e.environments || []).find((x) => x.id === '${ENV_ID}');
        process.stdout.write((env && env.ipfs) || '');
      } catch (e) { process.stdout.write(''); }
    " 2>/dev/null || echo "")
    if [ -z "$gateway" ]; then
        gateway="$DEFAULT_GATEWAY"
    fi
    local code
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 "$gateway" 2>/dev/null || echo "000")
    if [ "$code" = "000" ]; then
        record_result "IPFS gateway reachable" "FAIL" "no response from ${gateway} within 8s — check network/VPN/firewall, or the testnet gateway may itself be down (it is outside our control)."
    else
        record_result "IPFS gateway reachable" "PASS" "${gateway} responded HTTP ${code} (liveness only, not a content check)"
    fi
}

check_dotns_status() {
    # Deliberately not implemented as a live query. We tried the exported
    # DotNS.connect() + getContenthash() API and found it is not a
    # lightweight read: connect() drives full pool-account derivation and
    # EVM address mapping (ReviveApi.address), which is adjacent to the
    # deploy path itself and can fail independently of the thing we're
    # trying to check. Fabricating a check here would be worse than
    # admitting we don't have one. See e2e/BOOTSTRAP.md.
    record_result "decentralize-ci.paseo on-chain contenthash" "UNKNOWN" "cannot check without deploying — no supported read-only query found (see e2e/BOOTSTRAP.md). Use --register if you believe it needs (re)claiming."
}

# --- table + summary -----------------------------------------------------

print_table() {
    echo
    printf '%-42s %-8s %s\n' "CHECK" "STATUS" "DETAIL"
    printf '%-42s %-8s %s\n' "------------------------------------------" "--------" "------------------------------------------------------------"
    local i
    for i in "${!CHECK_NAMES[@]}"; do
        printf '%-42s %-8s %s\n' "${CHECK_NAMES[$i]}" "${CHECK_STATUS[$i]}" "${CHECK_DETAIL[$i]}"
    done
    echo
}

any_failed() {
    local i
    for i in "${!CHECK_STATUS[@]}"; do
        if [ "${CHECK_STATUS[$i]}" = "FAIL" ]; then
            return 0
        fi
    done
    return 1
}

# --- --register ------------------------------------------------------------

# Set by do_register, read by the EXIT trap. Deliberately NOT `local`: a
# `local` here would go out of scope the instant do_register returns, and
# the trap only fires later (at script exit) — under `set -u` that reads as
# an unbound variable, which either errors out of the trap or (worse) skips
# the cleanup, leaking the temp dir on an otherwise-successful run.
REGISTER_TMPDIR=""

do_register() {
    # This is the mirror image of the "sharp edge" documented in
    # e2e/BOOTSTRAP.md item 1: bulletin-deploy's *default* behaviour when a
    # mobile session is signed in is to register with the local worker and
    # then transfer the name to that signed-in account. Running --register
    # while signed in would silently move decentralize-ci.paseo off the
    # pool-fallback worker and onto a human's personal account, permanently
    # breaking the overwrite-path design (the CI worker would no longer own
    # it, and no `--register` re-run from CI could get it back). Refuse
    # rather than guess.
    local whoami_out
    whoami_out=$(cd "$REPO_ROOT" && node node_modules/bulletin-deploy/bin/bulletin-deploy whoami 2>&1 || true)
    if ! printf '%s' "$whoami_out" | grep -qi "not logged in"; then
        echo "Refusing --register: bulletin-deploy reports an active signed-in session:" >&2
        echo "  ${whoami_out//$'\n'/$'\n  '}" >&2
        echo "By default, registering while signed in hands ${DOT_LABEL}.paseo to that" >&2
        echo "signed-in account instead of the pool-fallback worker — this would break" >&2
        echo "the overwrite-path design permanently (see e2e/BOOTSTRAP.md item 1)." >&2
        echo "Run 'node node_modules/bulletin-deploy/bin/bulletin-deploy logout' first, then re-run --register." >&2
        exit 1
    fi

    echo "== --register: (re)claim ${DOT_LABEL}.paseo on ${ENV_ID} =="
    echo "This will:"
    echo "  1. Stage a minimal placeholder index.html in a throwaway temp directory."
    echo "  2. Run a REAL on-chain deploy:"
    echo "       node node_modules/bulletin-deploy/bin/bulletin-deploy <tmpdir> ${DOT_LABEL} --env ${ENV_ID}"
    echo "     (bare label — bulletin-deploy applies ${ENV_ID}'s own TLD, .paseo; see the"
    echo "     main README's Naming section for why this script does not append one)."
    echo "  3. Use the pool-fallback worker (no session, no --mnemonic, no secret)."
    echo "     Expected cost: ~11 PAS (oracle price 10 PAS + margin) — the worker no"
    echo "     longer holds ProofOfPersonhoodFull (see e2e/BOOTSTRAP.md item 4, updated"
    echo "     2026-08-18), so registerDepositWei charges the NoStatus price. The worker"
    echo "     is funded (~5005 PAS as of 2026-08-18) specifically to cover this — see"
    echo "     e2e/BOOTSTRAP.md item 4. If bulletin-deploy reports a balance failure,"
    echo "     the worker needs topping up again; see BOOTSTRAP.md item 4 for exactly"
    echo "     which address that is (the auto-top-up \"Alice\" cannot rescue it)."
    echo

    if [ "$ASSUME_YES" -ne 1 ]; then
        printf 'Proceed? [y/N] '
        read -r reply || reply=""
        case "$reply" in
            y | Y | yes | YES) ;;
            *)
                echo "Aborted."
                exit 1
                ;;
        esac
    fi

    if ! command -v ipfs >/dev/null 2>&1; then
        echo "Refusing: ipfs binary is required for this deploy (see checks above)." >&2
        exit 1
    fi

    REGISTER_TMPDIR=$(mktemp -d)
    trap 'rm -rf "${REGISTER_TMPDIR:-}"' EXIT
    {
        echo "<!doctype html><html><body>decentralize-ci bootstrap placeholder"
        echo "generated $(date -u +%Y-%m-%dT%H:%M:%SZ)</body></html>"
    } >"$REGISTER_TMPDIR/index.html"

    # Bare label — bulletin-deploy applies ${ENV_ID}'s own TLD (.paseo). Do
    # not append ".dot" here: bulletin-deploy 0.15.0 made the TLD
    # per-environment, and appending the wrong one fails outright with
    # 'Domain "…" ends in ".dot", but this environment uses ".paseo" names.'
    (cd "$REPO_ROOT" && node node_modules/bulletin-deploy/bin/bulletin-deploy "$REGISTER_TMPDIR" "${DOT_LABEL}" --env "${ENV_ID}")
}

# --- main ------------------------------------------------------------------

main() {
    parse_args "$@"

    check_node
    check_ipfs_binary
    check_ipfs_repo
    check_bulletin_pin
    check_manifest_exports
    check_gateway
    check_dotns_status

    print_table

    if [ "$REGISTER" -eq 1 ]; then
        if any_failed; then
            echo "Refusing --register: one or more required checks above FAILED. Fix those first — this is a real on-chain deploy and should not be spent on a broken environment." >&2
            exit 1
        fi
        do_register
        exit $?
    fi

    if any_failed; then
        echo "FAILED — one or more required checks did not pass. Each FAIL row's DETAIL column names the remedy; e2e/BOOTSTRAP.md has the full recovery runbook."
        exit 1
    fi

    echo "OK — all required checks passed. (An UNKNOWN row is expected and documented in e2e/BOOTSTRAP.md — it is not a failure.)"
    exit 0
}

main "$@"
