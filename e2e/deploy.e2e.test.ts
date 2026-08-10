// Copyright (C) Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
// GNU General Public License for more details.
//
// You should have received a copy of the GNU General Public License
// along with this program. If not, see <https://www.gnu.org/licenses/>.

/**
 * Real-chain e2e validation for `decentralize`, per the approved design:
 * docs-internal/superpowers/specs/2026-08-10-e2e-chain-validation-design.md
 *
 * `src/cli.test.ts` stops at the handoff to bulletin-deploy: it substitutes a
 * stub binary and asserts the argv the child was handed. That is the right
 * unit boundary, but it means nothing below the handoff is covered — not the
 * real merkleizer, not the real bulletin-deploy, not the chain. The gap
 * matters because a bad CAR SUCCEEDS: the deploy reports success and the site
 * then serves 404s (see the README's Kubo section). A test that only asserts
 * `exit 0` would sail straight through the bug we most need to catch.
 *
 * This suite makes ONE real deploy per case to Paseo Next v2, against the
 * fixed name `decentralize-ci.dot` (owned by bulletin-deploy's pool-fallback
 * worker — see e2e/BOOTSTRAP.md item 1 for the full rationale and its sharp
 * edges), and round-trips the on-chain contenthash back to the exact bytes
 * that were staged. Exit code alone is never the assertion.
 *
 * This file is NOT part of `npm test` — it is collected only by
 * `vitest.e2e.config.ts` (`npm run test:e2e`), is never wired to any required
 * check, and is not run on `pull_request`/`push` (see
 * .github/workflows/e2e.yml). It requires Kubo with an initialized repo,
 * network access to a public testnet, and `dist/cli.js` already built —
 * run `e2e/bootstrap.sh` first if anything below fails in a confusing way.
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { loadEnvironments, parseManifest, type EmbeddedManifest } from "bulletin-deploy";
import { fetchManifestRoundtrip } from "bulletin-deploy/manifest-roundtrip";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The one fixed DotNS label this whole suite deploys over. See the module
 *  doc comment and e2e/BOOTSTRAP.md item 1 for why it's fixed, not fresh. */
const DOT_LABEL = "decentralize-ci";
/** Must match e2e/bootstrap.sh's ENV_ID — kept as a literal here rather than
 *  shared code because bootstrap.sh is bash and this is TS; the design doc
 *  and BOOTSTRAP.md are the source of truth both sides are checked against. */
const ENV_ID = "paseo-next-v2";

/** IPFS gateway for ENV_ID, read from bulletin-deploy's own environments doc
 *  in `beforeAll` (not hardcoded — see the design doc step 5 and
 *  e2e/BOOTSTRAP.md item 3: `listEnvironments()` does NOT expose `ipfs`,
 *  only the full `loadEnvironments()` record does). */
let gateway: string;

/** Per-test temporaries (fixture dirs, throwaway HOMEs), removed after each case. */
const created: string[] = [];

function temp(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    created.push(dir);
    return dir;
}

afterEach(() => {
    while (created.length > 0) rmSync(created.pop()!, { recursive: true, force: true });
});

beforeAll(async () => {
    const { doc } = await loadEnvironments();
    const env = doc.environments.find((e) => e.id === ENV_ID);
    if (env?.ipfs === undefined) {
        throw new Error(
            `[setup] bulletin-deploy's environments doc has no "ipfs" gateway field for ` +
                `environment "${ENV_ID}" — either the pinned bulletin-deploy version changed this ` +
                `env's shape, or ENV_ID above is wrong. See e2e/BOOTSTRAP.md item 3.`,
        );
    }
    gateway = env.ipfs;
});

/**
 * A run-unique marker so a cached, stale, or accidentally-reused deploy
 * cannot satisfy the CID comparison below by coincidence. Uses the CI
 * identity when available; falls back to a local timestamp+random pair so
 * the suite also runs on a laptop (`npm run test:e2e` outside GitHub Actions).
 */
function runMarker(): string {
    const sha = process.env.GITHUB_SHA;
    const runNumber = process.env.GITHUB_RUN_NUMBER;
    if (sha !== undefined && sha !== "" && runNumber !== undefined && runNumber !== "") {
        return `${sha.slice(0, 12)}-${runNumber}`;
    }
    return `local-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Write a single-file fixture embedding `marker`. Returns its path and exact
 *  byte length (as bulletin-deploy/UTF-8 sees it, for the size assertion). */
function writeFixture(dir: string, marker: string): { path: string; bytes: number } {
    const html =
        `<!doctype html><title>decentralize e2e</title>` +
        `<body>decentralize e2e fixture — marker: ${marker}</body>`;
    const path = join(dir, "index.html");
    writeFileSync(path, html, "utf8");
    return { path, bytes: Buffer.byteLength(html, "utf8") };
}

/**
 * Compute the CID bulletin-deploy will produce for this exact file, using the
 * same flags bulletin-deploy uses internally (design doc step 2). This is the
 * independent, locally-computed value the deployed manifest is checked
 * against — the whole point of spending a real deploy is proving these match.
 */
function computeExpectedCid(filePath: string): string {
    // spawnSync is fine here (unlike runDeploy below): this is a local hash of
    // one small fixture file, no network round trip, done in well under a
    // second — it cannot starve the worker long enough for the reporter's
    // onTaskUpdate RPC to time out the way the ~80s real deploy did.
    const result = spawnSync(
        "ipfs",
        ["add", "-Q", "--cid-version=1", "--raw-leaves", "--pin=false", filePath],
        { encoding: "utf8" },
    );
    if (result.status !== 0) {
        throw new Error(
            `[setup] local CID computation failed (\`ipfs add\` exited ${result.status}): ` +
                `${result.stderr}`,
        );
    }
    return result.stdout.trim();
}

interface DeployRun {
    status: number | null;
    stdout: string;
    stderr: string;
}

/**
 * Run the BUILT CLI (`dist/cli.js`, matching what users install — not the
 * TypeScript source) against `decentralize-ci.dot`, with the child's session
 * state isolated.
 *
 * WHY THE HOME OVERRIDE EXISTS — bulletin-deploy's default behaviour, when a
 * `bulletin-deploy login` session is signed in, is to register with a local
 * worker and then TRANSFER THE NAME to the signed-in account (zero mobile
 * signatures required — see e2e/BOOTSTRAP.md item 1's "mirror-image sharp
 * edge"). This suite depends on `decentralize-ci.dot` staying owned by the
 * shared pool-fallback worker (`0x35Cdb23fF7fc86E8DCcd577CA309bFEA9c978D20`)
 * FOREVER, so every future run can overwrite it. If this suite ever ran on a
 * machine with an active session — a developer's laptop, most likely — the
 * deploy would silently and PERMANENTLY move the name onto that human's
 * account. That is not recoverable by re-running anything from CI, because
 * CI's pool worker would no longer own the name to overwrite. bulletin-deploy
 * resolves its session store from `os.homedir()/.polkadot-apps`, and Node's
 * `os.homedir()` resolves from `$HOME` — so pointing the CHILD's `HOME` at a
 * fresh, empty, throwaway temp directory guarantees no session is visible to
 * it, no matter what is signed in on the host running this test. This is
 * exactly the state the design's spike validated: with a throwaway HOME,
 * `whoami` reported "Not logged in" and the deploy took the pool-fallback
 * path with 0 PAS cost.
 *
 * WHY IPFS_PATH IS SET EXPLICITLY — a throwaway HOME also hides the real IPFS
 * repo (`~/.ipfs` lives under HOME too), and bulletin-deploy's merkleization
 * step dies without one: "no IPFS repo found in <HOME>/.ipfs. please run:
 * 'ipfs init'" — this is the exact failure that killed the design's first
 * spike. So the REAL `IPFS_PATH` is resolved from the ambient environment
 * (respecting an already-set `$IPFS_PATH`, else `$HOME/.ipfs`) BEFORE `HOME`
 * is overridden below, and passed through explicitly — pointing the isolated
 * child at the real, already-initialized repo even though its own `HOME` no
 * longer does.
 *
 * Do not "simplify" this by dropping either half: dropping the HOME override
 * reintroduces the silent name-transfer hazard above; dropping the
 * IPFS_PATH override reintroduces "no IPFS repo found" at merkleization.
 */
function runDeploy(fixtureDir: string, ownFlags: string[]): Promise<DeployRun> {
    const cliPath = join(repoRoot, "dist", "cli.js");
    if (!existsSync(cliPath)) {
        throw new Error(
            `[setup] ${cliPath} does not exist. This suite deploys the BUILT CLI (matching ` +
                `what users install), not the TypeScript source — run \`npm run build\` first.`,
        );
    }

    const realHome = process.env.HOME;
    if (realHome === undefined || realHome === "") {
        throw new Error(
            "[setup] $HOME is not set in this environment; cannot resolve the real IPFS repo " +
                "path before isolating the child's HOME. See runDeploy's doc comment.",
        );
    }
    // Resolved from the REAL environment, before HOME is overridden below.
    const realIpfsPath = process.env.IPFS_PATH ?? join(realHome, ".ipfs");
    const throwawayHome = temp("decentralize-e2e-throwaway-home-");

    // Real chain writes: finalization + a chunked upload can legitimately take
    // a couple of minutes. Well under the 300s test timeout so a genuine hang
    // still fails the test rather than the process.
    const TIMEOUT_MS = 240_000;

    // spawn, not spawnSync: spawnSync blocks this worker thread for the
    // ~80s+ the real deploy takes, during which the worker cannot service
    // vitest's own reporter RPC (`onTaskUpdate`) — that RPC then times out
    // and vitest reports an "Unhandled Error" on an otherwise-passing run.
    // spawn keeps the event loop live for the duration of the deploy, so the
    // reporter can still be serviced; the Promise below resolves on `close`
    // with the exact `{ status, stdout, stderr }` shape spawnSync used to
    // return, so none of the assertion logic downstream needs to change.
    return new Promise<DeployRun>((settle, reject) => {
        const child = spawn(
            process.execPath,
            [cliPath, fixtureDir, "--dot", DOT_LABEL, ...ownFlags, "--", "--env", ENV_ID],
            {
                env: {
                    ...process.env,
                    HOME: throwawayHome,
                    IPFS_PATH: realIpfsPath,
                },
                // stdin: "ignore" (not an empty pipe) guarantees bulletin-deploy sees a
                // non-TTY stdin and takes its non-interactive branch everywhere it
                // checks `isInteractive()` (process.stdin.isTTY && !process.env.CI) —
                // verified against the pinned 0.14.2: version-check's update nudge and
                // the crash-report "open an issue?" prompt are both gated behind that
                // same check, and there is no separate confirmation prompt for the
                // overwrite path itself (grepped the compiled deploy chunk for
                // readline/isTTY use — none found there). So a non-TTY stdin cannot
                // hang this run waiting on input that will never arrive.
                stdio: ["ignore", "pipe", "pipe"],
            },
        );

        // bulletin-deploy's output passes through unfiltered (README: "All of
        // bulletin-deploy's output passes through unfiltered") and a chunked
        // upload's progress/spinner redraws are verbose. spawnSync's 1 MB
        // default maxBuffer used to be a real risk here (SIGTERM + truncated
        // stdout, misreported as "[marker missing]"), which is why this used
        // to set an explicit 64 MB ceiling. That ceiling no longer applies at
        // all: `spawn` has no maxBuffer of its own — we accumulate stdout and
        // stderr ourselves below by concatenating streamed chunks, with no
        // upper bound.
        let stdout = "";
        let stderr = "";
        child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
            stdout += chunk;
        });
        child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
            stderr += chunk;
        });

        // spawn has no built-in `timeout`/`killSignal` option on every Node
        // version this suite might run under, so the kill-on-timeout budget
        // is implemented explicitly: a timer kills the child with SIGKILL if
        // it's still running when the budget expires, and is always cleared
        // on `close` so it can never fire after the child has already exited.
        let timedOut = false;
        const timer = setTimeout(() => {
            timedOut = true;
            child.kill("SIGKILL");
        }, TIMEOUT_MS);

        // A spawn failure (e.g. the executable could not be launched at all)
        // surfaces here as a clear rejection, not a silent hang waiting for a
        // `close` event that will never come.
        child.on("error", (err) => {
            clearTimeout(timer);
            reject(err);
        });

        child.on("close", (code) => {
            clearTimeout(timer);
            if (timedOut) {
                stderr +=
                    `\n[timeout] deploy exceeded its ${TIMEOUT_MS}ms budget and was killed ` +
                    "with SIGKILL; output above is whatever was captured before the kill.\n";
            }
            settle({ status: code, stdout, stderr });
        });
    });
}

interface VerifiedDeploy {
    manifest: EmbeddedManifest;
    expectedCid: string;
    fixtureBytes: number;
}

/**
 * Run the full assertion chain from the design doc (steps 1-5): stage a
 * marked fixture, compute its expected CID, deploy, scrape the on-chain
 * contenthash from stdout, then fetch and parse the deployed manifest.
 *
 * Every failure here is thrown with a `[link-name]` prefix identifying which
 * link in the chain broke — deploy / marker / gateway / manifest — so a
 * testnet outage reads differently from a real regression in `decentralize`,
 * per the design doc's "Failure reporting" section. Steps 6-7 (the per-file
 * CID/size/file-set assertions) are left to the caller, since the two test
 * cases below check different things there.
 */
async function deployAndVerify(caseLabel: string, ownFlags: string[]): Promise<VerifiedDeploy> {
    const marker = `${runMarker()}-${caseLabel}`;
    const fixtureDir = temp(`decentralize-e2e-fixture-${caseLabel}-`);
    const { path: indexPath, bytes: fixtureBytes } = writeFixture(fixtureDir, marker);
    const expectedCid = computeExpectedCid(indexPath);

    const run = await runDeploy(fixtureDir, ownFlags);
    if (run.status !== 0) {
        throw new Error(
            `[deploy failed] decentralize exited ${run.status} (expected 0).\n` +
                `--- stdout ---\n${run.stdout}\n--- stderr ---\n${run.stderr}`,
        );
    }

    const match = /Verified on-chain:\s*(\S+)/.exec(run.stdout);
    if (match === null) {
        throw new Error(
            "[marker missing] deploy exited 0, but its output did not contain " +
                '"Verified on-chain: <contenthash>" — bulletin-deploy\'s output format may have ' +
                `changed, or the deploy silently skipped the on-chain write.\n--- stdout ---\n${run.stdout}`,
        );
    }
    const cid = match[1];

    // Gateway propagation after finalization can lag by seconds; this budget
    // leaves headroom under the 300s test timeout alongside the deploy itself.
    const roundtrip = await fetchManifestRoundtrip(cid, { gateway, budgetMs: 90_000 });
    if (!roundtrip.ok) {
        throw new Error(
            `[gateway fetch failed] could not retrieve the manifest for ${cid} from ${gateway}: ` +
                `${roundtrip.reason}`,
        );
    }

    const manifestText = Buffer.from(roundtrip.manifestBytes).toString("utf8");
    const parsed = parseManifest(manifestText);
    if (!parsed.ok) {
        throw new Error(`[manifest parse failed] ${parsed.error}\n--- raw manifest ---\n${manifestText}`);
    }

    return { manifest: parsed.manifest, expectedCid, fixtureBytes };
}

/**
 * Both cases below deploy to the SAME name, `decentralize-ci.dot`, one after
 * the other rather than to two separate names. That is a deliberate choice,
 * not an oversight:
 *
 * - It is safe, not a race: vitest runs `it` blocks within a file
 *   sequentially by default, and neither case below opts into
 *   `test.concurrent`. The first case's deploy AND its assertions complete in
 *   full before the second case's deploy begins — they never overlap in time.
 * - Two real deploys ARE unavoidable here, regardless of naming: the point of
 *   this suite is to prove the DEFAULT archive contains exactly `index.html`
 *   (the permanent regression guard for bulletin-deploy#1233 / PR #1) and
 *   that the `--fallback` archive contains all three files — and only an
 *   actual deploy of each configuration exercises what bulletin-deploy
 *   really chunks and uploads for it. There is no way to check both
 *   behaviours with a single deploy.
 * - A second registered NoStatus-class name (base length >= 9, 0 or 2
 *   trailing digits — see the design doc's table) was considered and
 *   rejected: it would need its own bootstrap/registration step and its own
 *   entry in e2e/BOOTSTRAP.md, for zero benefit, since the two deploys in
 *   this file never run concurrently. TWO CONCURRENT WORKFLOW RUNS racing on
 *   this one name is a real hazard — but that is handled at the workflow
 *   level instead, by `concurrency: { group: ..., cancel-in-progress: false }`
 *   in .github/workflows/e2e.yml, which queues a second run rather than
 *   letting it overlap the first.
 * - Verified this is not merely "usually true": the "exactly index.html"
 *   guard below would be unsound if a deployed manifest's `files` map ever
 *   carried forward entries from the PREVIOUS on-chain manifest (via
 *   `previous_contenthash`) instead of reflecting only the current archive —
 *   that would make the fallback case's run leave stale 404.html/_redirects
 *   entries for the next run's default case to trip over. Read the pinned
 *   0.14.2's `buildFilesMap` (bulletin-deploy's compiled
 *   `dist/chunk-6LD3Z2HM.js`): it walks the CURRENT staged directory only and
 *   builds `files` fresh each time; nothing merges in the previous manifest's
 *   file list. Each deploy's manifest reflects exactly what was staged for it.
 */
describe("deploy.e2e — decentralize-ci.dot on Paseo Next v2", () => {
    it(
        "deploys the default archive, and the deployed manifest matches the staged bytes exactly (no --fallback)",
        async () => {
            const { manifest, expectedCid, fixtureBytes } = await deployAndVerify("default", []);

            const entry = manifest.files["index.html"];
            expect(
                entry,
                `[manifest mismatch] index.html missing from the deployed manifest.files ` +
                    `(got: ${JSON.stringify(Object.keys(manifest.files))})`,
            ).toBeDefined();
            expect(
                entry!.cid,
                "[manifest mismatch] deployed index.html CID does not match the locally computed CID " +
                    "— the bytes bulletin-deploy chunked and uploaded differ from the staged fixture",
            ).toBe(expectedCid);
            expect(
                entry!.size,
                "[manifest mismatch] deployed index.html size does not match the fixture's byte length",
            ).toBe(fixtureBytes);

            // Permanent regression guard for bulletin-deploy#1233 / PR #1: the
            // default archive (no --fallback) must contain EXACTLY index.html —
            // no byte-identical 404.html, no _redirects riding along as dead
            // weight that doubles the on-chain chunk count for nothing.
            expect(
                Object.keys(manifest.files).sort(),
                "[manifest mismatch] the default deploy must contain exactly index.html — a 404.html " +
                    "or _redirects showing up here means the no-fallback-by-default regression is back",
            ).toEqual(["index.html"]);
        },
        300_000,
    );

    it(
        "also deploys the fallback files under --fallback, and all three appear in the manifest",
        async () => {
            const { manifest } = await deployAndVerify("fallback", ["--fallback"]);

            expect(
                Object.keys(manifest.files).sort(),
                "[manifest mismatch] the --fallback deploy must contain all three files",
            ).toEqual(["404.html", "_redirects", "index.html"]);
        },
        300_000,
    );
});
