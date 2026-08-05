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
 * End-to-end tests for cli.ts, covering the one thing index.test.ts cannot: the
 * handoff to bulletin-deploy. Everything up to `spawnSync` is exercised by a
 * --dry-run, but the spawn line itself, the argv it builds, and what happens to
 * the child's exit code were previously unexercised.
 *
 * The child here is a STUB, not the real bulletin-deploy: a real run needs a
 * funded signer and writes a DotNS name on-chain, which is not a unit test. The
 * stub records the argv it was handed and exits with a code we choose, which is
 * exactly the contract cli.ts depends on. `BULLETIN_DEPLOY_BIN` is the intended
 * seam for this — it exists so a local checkout can be substituted.
 *
 * Two environmental details make these deterministic:
 *
 *   - The CLI is compiled to a throwaway outDir rather than reused from `dist/`.
 *     CI runs `npm test` BEFORE `npm run build`, so `dist/` may not exist; and
 *     building into it here would turn the later build step into a no-op check.
 *     The outDir sits under `node_modules/` so that cli.ts's walk-up for the
 *     pinned bulletin-deploy manifest still resolves against this package.
 *   - A stub `ipfs` is put on PATH. The Kubo preflight is deliberately fatal,
 *     and CI runners do not have Kubo, so without this every case would die at
 *     the preflight instead of reaching the spawn.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Compiled cli.js under test. */
let cliPath: string;
/** Directory holding the stub `ipfs`, prepended to the child's PATH. */
let stubBinDir: string;
/** Stub stand-in for the bulletin-deploy binary. */
let stubDeployPath: string;

/** Per-test temporaries, removed after each case. */
const created: string[] = [];

/** Everything the stub child saw, written out for the test to inspect. */
interface StubRecord {
    argv: string[];
    /** Contents of the upload root at the moment the child ran. */
    uploadRootFiles: string[];
}

function temp(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    created.push(dir);
    return dir;
}

beforeAll(() => {
    // Compile into node_modules/ (already ignored by git and npm's `files`),
    // keeping dist/ untouched.
    const outDir = join(repoRoot, "node_modules", ".cache", "decentralize-cli-test");
    rmSync(outDir, { recursive: true, force: true });
    const tsc = spawnSync(
        process.execPath,
        [
            join(repoRoot, "node_modules", "typescript", "bin", "tsc"),
            "-p",
            join(repoRoot, "tsconfig.json"),
            "--outDir",
            outDir,
        ],
        { encoding: "utf8" },
    );
    if (tsc.status !== 0) {
        throw new Error(`could not compile the CLI under test:\n${tsc.stdout}${tsc.stderr}`);
    }
    cliPath = join(outDir, "cli.js");
    if (!existsSync(cliPath)) throw new Error(`compiled CLI missing at ${cliPath}`);

    // NOT registered in `created`: this one has to outlive afterEach, since
    // every case reuses it.
    stubBinDir = mkdtempSync(join(tmpdir(), "decentralize-cli-bin-"));

    // `onPath` only stats the candidate, so an empty file is a sufficient stub.
    writeFileSync(join(stubBinDir, "ipfs"), "");

    // .cjs so Node picks the module system regardless of any ambient
    // package.json, and so cli.ts's `\.(js|mjs|cjs)$` branch runs it with
    // process.execPath rather than exec'ing it directly.
    stubDeployPath = join(stubBinDir, "stub-bulletin-deploy.cjs");
    writeFileSync(
        stubDeployPath,
        [
            "const { readdirSync, writeFileSync } = require('node:fs');",
            "const argv = process.argv.slice(2);",
            "writeFileSync(process.env.STUB_RECORD, JSON.stringify({",
            "    argv,",
            // Read the upload root from inside the child: proves the archive is
            // still staged while the deploy runs, not cleaned up underneath it.
            "    uploadRootFiles: readdirSync(argv[0]).sort(),",
            "}), 'utf8');",
            "process.stdout.write('stub bulletin-deploy ran\\n');",
            "process.exit(Number(process.env.STUB_EXIT ?? '0'));",
            "",
        ].join("\n"),
    );
}, 120_000);

afterEach(() => {
    while (created.length > 0) rmSync(created.pop()!, { recursive: true, force: true });
});

afterAll(() => {
    rmSync(stubBinDir, { recursive: true, force: true });
});

/** A minimal deployable app: one index.html at the root. */
function app(): string {
    const dir = temp("decentralize-cli-src-");
    writeFileSync(join(dir, "index.html"), "<!doctype html><title>t</title><h1>hi</h1>");
    return dir;
}

interface Run {
    status: number | null;
    stdout: string;
    stderr: string;
    /** What the stub child recorded, or null if it never ran. */
    record: StubRecord | null;
}

/**
 * Run the compiled CLI with the stub standing in for bulletin-deploy.
 *
 * `deployBin: null` omits BULLETIN_DEPLOY_BIN entirely, exercising the pinned
 * dependency resolution instead of the override.
 */
function run(
    args: string[],
    opts: { exitCode?: number; path?: string; deployBin?: string | null } = {},
): Run {
    const recordPath = join(temp("decentralize-cli-rec-"), "record.json");
    const env: Record<string, string> = {
        ...(process.env as Record<string, string>),
        PATH: opts.path ?? `${stubBinDir}:${process.env.PATH ?? ""}`,
        STUB_RECORD: recordPath,
        STUB_EXIT: String(opts.exitCode ?? 0),
    };
    const bin = opts.deployBin === undefined ? stubDeployPath : opts.deployBin;
    if (bin === null) delete env.BULLETIN_DEPLOY_BIN;
    else env.BULLETIN_DEPLOY_BIN = bin;

    const result = spawnSync(process.execPath, [cliPath, ...args], {
        encoding: "utf8",
        env,
        // Belt and braces: the pinned-resolution case below reaches the spawn
        // line with the REAL binary behind it and relies on --dry-run returning
        // first. If that short-circuit ever regresses, fail the run rather than
        // let a password prompt hang CI.
        timeout: 120_000,
        killSignal: "SIGKILL",
    });
    return {
        status: result.status,
        stdout: result.stdout,
        stderr: result.stderr,
        record: existsSync(recordPath)
            ? (JSON.parse(readFileSync(recordPath, "utf8")) as StubRecord)
            : null,
    };
}

describe("the handoff to bulletin-deploy", () => {
    it("passes the staged upload root, the normalised domain, then forwarded args", () => {
        const out = run([app(), "--dot", "myapp", "--", "--env", "paseo-next-v2"]);

        expect(out.status).toBe(0);
        expect(out.record).not.toBeNull();
        const argv = out.record!.argv;
        // Positional order is the contract: root, then name, then passthrough.
        expect(argv.slice(1)).toEqual(["myapp.dot", "--env", "paseo-next-v2"]);
        expect(argv[0]).toContain("decentralize-");
        expect(out.stdout).toContain("✔ Deployed myapp.dot");
    });

    it("hands the child a directory that still holds the staged archive", () => {
        const out = run([app(), "--dot", "myapp"]);

        // The child read this itself, so it cannot be satisfied by a path that
        // was staged and then cleaned up before the spawn.
        expect(out.record!.uploadRootFiles).toEqual(["404.html", "_redirects", "index.html"]);
    });

    it("lets the child's output through to the terminal", () => {
        // stdio: "inherit" is a deliberate choice — bulletin-deploy's progress
        // and its interactive password prompt both depend on it.
        expect(run([app(), "--dot", "myapp"]).stdout).toContain("stub bulletin-deploy ran");
    });

    it("adopts a failing child's exit code instead of reporting success", () => {
        const out = run([app(), "--dot", "myapp"], { exitCode: 3 });

        expect(out.status).toBe(3);
        expect(out.stderr).toContain("bulletin-deploy exited 3");
        expect(out.stdout).not.toContain("✔ Deployed");
    });

    it("cleans up the staging directory even when the deploy fails", () => {
        const out = run([app(), "--dot", "myapp"], { exitCode: 3 });

        // The cleanup sits in a `finally`, so a failed deploy must not leak it.
        expect(existsSync(out.record!.argv[0]!)).toBe(false);
    });

    it("keeps the staging directory, and says where, under --keep-staging", () => {
        const out = run([app(), "--dot", "myapp", "--keep-staging"]);

        const kept = /staging kept at (.+)/.exec(out.stdout)?.[1]?.trim();
        expect(kept).toBeDefined();
        expect(existsSync(kept!)).toBe(true);
        created.push(kept!);
        // The upload root lives inside the staging directory it reports.
        expect(out.record!.argv[0]!.startsWith(kept!)).toBe(true);
    });

    it("spawns nothing at all on --dry-run", () => {
        const out = run([app(), "--dot", "myapp", "--dry-run"]);

        expect(out.status).toBe(0);
        expect(out.stdout).toContain("Would run");
        expect(out.record).toBeNull();
    });
});

describe("preflight, before anything is staged", () => {
    it("resolves the pinned dependency when no override is set", () => {
        // No BULLETIN_DEPLOY_BIN: this is the path a real user takes. Stop at
        // --dry-run so the real binary is never invoked.
        const out = run([app(), "--dot", "myapp", "--dry-run"], { deployBin: null });

        expect(out.status).toBe(0);
        const version = JSON.parse(
            readFileSync(join(repoRoot, "node_modules", "bulletin-deploy", "package.json"), "utf8"),
        ) as { version: string };
        expect(out.stdout).toContain(`Using bulletin-deploy@${version.version} (pinned dependency)`);
        expect(out.stdout).toContain(join("node_modules", "bulletin-deploy"));
    });

    it("refuses a BULLETIN_DEPLOY_BIN that does not exist", () => {
        const missing = join(stubBinDir, "not-here.cjs");
        const out = run([app(), "--dot", "myapp"], { deployBin: missing });

        expect(out.status).toBe(1);
        expect(out.stderr).toContain(`BULLETIN_DEPLOY_BIN does not exist: ${missing}`);
        expect(out.record).toBeNull();
        // Resolution is checked before staging, so nothing was written.
        expect(out.stdout).not.toContain("Staged");
    });

    it("stops when Kubo is absent rather than risking a silently broken CAR", () => {
        const out = run([app(), "--dot", "myapp"], { path: temp("decentralize-cli-nopath-") });

        expect(out.status).toBe(1);
        expect(out.stderr).toContain("ipfs (Kubo) not found on PATH");
        expect(out.record).toBeNull();
    });

    it("proceeds without Kubo when --js-merkle is explicitly forwarded", () => {
        const out = run([app(), "--dot", "myapp", "--", "--js-merkle"], {
            path: temp("decentralize-cli-nopath-"),
        });

        expect(out.status).toBe(0);
        expect(out.record!.argv.slice(1)).toEqual(["myapp.dot", "--js-merkle"]);
    });
});
