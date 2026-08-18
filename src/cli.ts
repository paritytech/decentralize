#!/usr/bin/env node
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
 * CLI wrapper: stage, print the plan, then exec bulletin-deploy and inherit its
 * output. All the reusable logic lives in `index.ts`.
 */

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { type Args, listTree, parseArgs, stageArchive, UsageError } from "./index.js";

/** How many staged paths to print in the tree preview before truncating. */
const TREE_PREVIEW_LIMIT = 40;

/** Locate an executable on PATH without invoking a shell. */
function onPath(command: string): string | null {
    for (const dir of (process.env.PATH ?? "").split(":")) {
        if (dir === "") continue;
        const candidate = join(dir, command);
        try {
            if (statSync(candidate).isFile()) return candidate;
        } catch {}
    }
    return null;
}

interface Spawnable {
    command: string;
    prefixArgs: string[];
    description: string;
}

/**
 * Locate an installed dependency's package.json by walking up through
 * `node_modules` directories.
 *
 * `require.resolve` cannot be used here: bulletin-deploy declares an `exports`
 * map that does not include `./package.json` (so the subpath is blocked with
 * ERR_PACKAGE_PATH_NOT_EXPORTED), and its `.` entry is import-only (so resolving
 * the bare specifier from CJS fails too). Reading the file path directly is not
 * subject to `exports` restrictions. Walking up also handles npm hoisting.
 */
function findDependencyManifest(name: string): string | null {
    let dir = dirname(fileURLToPath(import.meta.url));
    for (;;) {
        const candidate = join(dir, "node_modules", name, "package.json");
        if (existsSync(candidate)) return candidate;
        const parent = dirname(dir);
        if (parent === dir) return null;
        dir = parent;
    }
}

/**
 * Resolve bulletin-deploy, preferring OUR PINNED DEPENDENCY.
 *
 * Pinning matters: bulletin-deploy 0.13.x silently rewrites non-compliant DotNS
 * labels and can retarget a deploy at a different name (its issue #1189), so a
 * stale global install is a real hazard. `npm install` gets a known-good version
 * and we invoke that copy rather than whatever happens to be on PATH.
 *
 * `BULLETIN_DEPLOY_BIN` still wins, for testing a local checkout.
 *
 * The resolved entrypoint is run with our own `process.execPath` rather than
 * executed directly, which sidesteps shebang and file-mode issues and pins the
 * Node that runs it (bulletin-deploy requires Node >= 22).
 */
function resolveBulletinDeploy(): Spawnable {
    const override = process.env.BULLETIN_DEPLOY_BIN;
    if (override !== undefined && override !== "") {
        if (!existsSync(override)) {
            throw new UsageError(`BULLETIN_DEPLOY_BIN does not exist: ${override}`);
        }
        return /\.(js|mjs|cjs)$/.test(override) || override.includes("/bin/")
            ? { command: process.execPath, prefixArgs: [override], description: override }
            : { command: override, prefixArgs: [], description: override };
    }

    try {
        const manifestPath = findDependencyManifest("bulletin-deploy");
        if (manifestPath === null) throw new Error("not found in any ancestor node_modules");
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
            version?: string;
            bin?: string | Record<string, string>;
        };
        const rel =
            typeof manifest.bin === "string"
                ? manifest.bin
                : (manifest.bin?.["bulletin-deploy"] ?? "./bin/bulletin-deploy");
        const entry = resolve(dirname(manifestPath), rel);
        if (!existsSync(entry)) {
            throw new Error(`declared bin missing at ${entry}`);
        }
        return {
            command: process.execPath,
            prefixArgs: [entry],
            description: `bulletin-deploy@${manifest.version ?? "?"} (pinned dependency)`,
        };
    } catch {
        // Fall through to a clear install message rather than silently using a
        // PATH copy of unknown version.
        const stray = onPath("bulletin-deploy");
        throw new UsageError(
            "bulletin-deploy is not installed — run `npm install` in this package" +
                (stray === null
                    ? "."
                    : `.\n  (A copy exists at ${stray}, but it is deliberately NOT used: ` +
                      "an unpinned version may silently retarget your deploy. Set " +
                      "BULLETIN_DEPLOY_BIN to use it anyway.)"),
        );
    }
}

function printUsage(): void {
    process.stdout.write(
        "\ndecentralize — stage a file or folder as an SPA archive, then deploy it to Polkadot\n\n" +
            "Usage:\n" +
            "  decentralize <file-or-dir> --dot <name> [options] [-- <bulletin-deploy args>]\n\n" +
            "Options:\n" +
            "  --dot <name>      DotNS name, with or without `.dot` (required). The TLD is\n" +
            "                    chosen by the target environment (--env), not by this\n" +
            "                    tool — e.g. paseo-next-v2 registers under `.paseo`.\n" +
            "  --path <dir>      Explicit alternative to the bare positional source\n" +
            "  --entry <file>    Entry file to use as index.html (skips auto-detection)\n" +
            "  --fallback        Also write 404.html + _redirects (off by default; see README)\n" +
            "  --keep-staging    Leave the staging directory on disk\n" +
            "  --dry-run         Stage and print the plan, deploy nothing\n" +
            "  --help            Show this help\n\n" +
            "Unrecognised flags are forwarded to bulletin-deploy verbatim (--env, --password,\n" +
            "--publish, --mnemonic, …). Use `--` to end this tool's own parsing.\n\n" +
            "Requires the IPFS Kubo binary (`ipfs`) on PATH for content addressing.\n\n",
    );
}

function main(): void {
    let args: Args;
    try {
        args = parseArgs(process.argv.slice(2));
    } catch (err) {
        if (err instanceof UsageError) {
            if (err.message !== "help") process.stderr.write(`\n✖ ${err.message}\n`);
            printUsage();
            process.exit(err.message === "help" ? 0 : 1);
        }
        throw err;
    }

    // Preflight both external requirements BEFORE staging, so a missing
    // dependency costs nothing.
    let deploy: Spawnable;
    try {
        deploy = resolveBulletinDeploy();
        if (onPath("ipfs") === null && !args.passthrough.includes("--js-merkle")) {
            // Kubo is required on purpose. bulletin-deploy's pure-JS merkleizer
            // has historically produced un-walkable CARs, and that failure mode
            // is silent: the deploy SUCCEEDS and the site serves 404s. A missing
            // binary is a loud error fixed by one install; a bad CAR is an
            // afternoon. Opt in explicitly if you need it.
            throw new UsageError(
                "ipfs (Kubo) not found on PATH — it is needed for content addressing. " +
                    "Install it (`brew install ipfs`), or pass --js-merkle to use the pure-JS " +
                    "merkleizer (slower, and historically produced un-walkable CARs — a broken " +
                    "deploy can look successful).",
            );
        }
    } catch (err) {
        process.stderr.write(`\n✖ ${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(1);
    }

    let staged;
    try {
        staged = stageArchive({
            source: args.source,
            entry: args.entry,
            fallback: args.fallback,
        });
    } catch (err) {
        process.stderr.write(`\n✖ ${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(1);
    }

    try {
        process.stdout.write(`\n▸ Staged ${resolve(args.source)}\n`);
        for (const action of staged.actions) process.stdout.write(`  • ${action}\n`);

        if (staged.excluded.length > 0) {
            process.stdout.write(
                `  ⚠ NOT uploaded — outside the upload root: ${staged.excluded.join(", ")}\n` +
                    "    (the archive root must hold index.html; point --path at the right " +
                    "directory if these are needed)\n",
            );
        }
        process.stdout.write(`  → upload root ${staged.uploadRoot}\n`);

        const files = listTree(staged.uploadRoot);
        process.stdout.write(`\n▸ Archive contents (${files.length} files)\n`);
        for (const file of files.slice(0, TREE_PREVIEW_LIMIT)) {
            process.stdout.write(`  ${file}\n`);
        }
        if (files.length > TREE_PREVIEW_LIMIT) {
            process.stdout.write(`  … ${files.length - TREE_PREVIEW_LIMIT} more\n`);
        }

        const deployArgs = [...deploy.prefixArgs, staged.uploadRoot, args.domain, ...args.passthrough];
        process.stdout.write(`\n▸ Using ${deploy.description}\n`);
        process.stdout.write(
            `▸ ${args.dryRun ? "Would run" : "Running"}: ${deploy.command} ${deployArgs.join(" ")}\n\n`,
        );

        if (args.dryRun) {
            process.stdout.write("✔ Dry run — nothing deployed.\n\n");
            return;
        }

        // stdio: "inherit" is the whole point: bulletin-deploy's verbose output
        // reaches the terminal unfiltered, and its exit code becomes ours.
        const result = spawnSync(deploy.command, deployArgs, { stdio: "inherit" });
        if (result.error !== undefined) throw result.error;
        if (result.status !== 0) {
            process.stderr.write(`\n✖ bulletin-deploy exited ${result.status ?? "on a signal"}\n`);
            process.exitCode = result.status ?? 1;
            return;
        }
        process.stdout.write(`\n✔ Deployed ${args.domain}\n\n`);
    } finally {
        if (args.keepStaging) {
            process.stdout.write(`  staging kept at ${staged.stagingDir}\n`);
        } else {
            rmSync(staged.stagingDir, { recursive: true, force: true });
        }
    }
}

try {
    main();
} catch (err) {
    process.stderr.write(`\n✖ ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
}
