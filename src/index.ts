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
 * decentralize — stage a file or folder as a correct single-page-app archive,
 * then hand it to `bulletin-deploy` for the upload + DotNS registration.
 *
 * This module is the pure/testable half: argument parsing, domain validation,
 * entry resolution, staging. The CLI wrapper lives in `cli.ts`.
 *
 * WHY THIS EXISTS — the load-bearing fact is that `index.html` MUST sit at the
 * ROOT of the uploaded archive. The Polkadot app sandbox loads the deployed
 * content by asking the archive for a root document; if there is none it
 * refuses outright with "Archive missing index.html — cannot render a sandbox
 * without a root document" (observed live on paseo.li, 2026-08-05). A build
 * whose entry is `main.html`, or that nests its output one directory deeper,
 * therefore does not merely lose deep links — it does not load at all. This
 * tool renames/hoists the entry so that cannot happen, and otherwise stays out
 * of the way.
 *
 * WHAT THIS DOES NOT FIX — SPA routes are not addressable on this platform, and
 * no upload-side trick changes that:
 *   - the sandbox origin refuses top-level entry ("not a standalone entry
 *     point"), so a deep URL cannot be opened or shared directly;
 *   - the host frames the app as `<name>.app.<gateway>/?cid=<root>&…` and the
 *     sandbox then scrubs its own query string, so an in-frame reload loses the
 *     required `cid` and the host restarts the app at its root;
 *   - the address bar only ever shows the host URL, which does not encode the
 *     app's internal route.
 * Keep routing in memory; do not promise users refresh-to-route or shareable
 * deep links. `404.html` / `_redirects` are read by neither the sandbox nor
 * polkadot-desktop — they are written only as harmless insurance for a plain
 * Kubo gateway, so they are OFF by default and `--fallback` opts in. A
 * byte-identical `404.html` copy of `index.html` is not free: it doubles the
 * bytes bulletin-deploy has to chunk and upload for something neither of this
 * tool's real deployment targets ever reads (see `writeFallbackFiles` below,
 * and bulletin-deploy#1233 for how badly that cost compounds in the 1-2 MB
 * chunking band).
 */

import {
    cpSync,
    existsSync,
    mkdtempSync,
    readdirSync,
    renameSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";

/** Entry filenames accepted as "obviously the app entry" when index.html is
 *  absent and more than one .html sits at the root. Ordered by preference. */
export const ENTRY_PREFERENCE = [
    "index.html",
    "main.html",
    "app.html",
    "home.html",
    "default.html",
];

/** Body of the `_redirects` file written for plain Kubo gateways. */
export const REDIRECTS_BODY = "/* /index.html 200\n";

/**
 * Directory/file names never copied into the archive.
 *
 * Everything uploaded here becomes part of a PUBLIC website, so build and VCS
 * metadata must not ride along. Two of these are load-bearing rather than
 * cosmetic:
 *   - `.git` — pointing this at a project root instead of its build output
 *     would otherwise publish the entire repository history.
 *   - `.bulletin-deploy` — bulletin-deploy writes its incremental-upload
 *     manifest cache into the build directory; that is internal deploy state,
 *     not site content.
 */
export const EXCLUDED_FROM_ARCHIVE = [
    ".git",
    ".bulletin-deploy",
    "node_modules",
    ".DS_Store",
];

/** Thrown for anything the user can fix by changing their invocation. */
export class UsageError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "UsageError";
    }
}

export interface Args {
    /** File or directory to deploy. */
    source: string;
    /** DotNS label. A trailing `.dot` typed by the user is stripped to the
     *  bare label; everything else is forwarded unchanged. bulletin-deploy
     *  applies its own environment's TLD (e.g. `.paseo` for the default
     *  paseo-next-v2 environment) — see `normaliseDomain`. */
    domain: string;
    /** Explicit entry file relative to `source` (skips auto-detection). */
    entry: string | null;
    /** Write 404.html + _redirects alongside index.html. Off by default — see
     *  `--fallback` in parseArgs and the module doc comment above. */
    fallback: boolean;
    /** Leave the staging directory on disk for inspection. */
    keepStaging: boolean;
    /** Stage + print the plan, but do not invoke bulletin-deploy. */
    dryRun: boolean;
    /** Forwarded to bulletin-deploy verbatim. */
    passthrough: string[];
}

/**
 * Hand-rolled parsing, so this package has no CLI-framework dependency.
 *
 * Unknown flags are forwarded to bulletin-deploy. A forwarded flag's value is
 * picked up with a lookahead: `--env paseo` forwards both tokens because
 * `paseo` does not start with `-`. That heuristic mis-reads a forwarded BOOLEAN
 * flag immediately followed by the source path, which is why `--` exists and
 * why `--path` is accepted as an explicit alternative to the bare positional.
 */
export function parseArgs(argv: string[]): Args {
    let source: string | null = null;
    let domain: string | null = null;
    let entry: string | null = null;
    let fallback = false;
    let keepStaging = false;
    let dryRun = false;
    const passthrough: string[] = [];

    const needsValue = (flag: string, value: string | undefined): string => {
        if (value === undefined || value.startsWith("-")) {
            throw new UsageError(`${flag} requires a value`);
        }
        return value;
    };

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];

        // Everything after a bare `--` is bulletin-deploy's, verbatim.
        if (arg === "--") {
            passthrough.push(...argv.slice(i + 1));
            break;
        }

        switch (arg) {
            case "--dot":
            case "--domain":
                domain = needsValue(arg, argv[++i]);
                continue;
            case "--path":
            case "--source":
                source = needsValue(arg, argv[++i]);
                continue;
            case "--entry":
                entry = needsValue(arg, argv[++i]);
                continue;
            case "--fallback":
                fallback = true;
                continue;
            case "--no-fallback":
                // No longer changes the default (it's already false), but this
                // case MUST stay. Every unrecognised flag falls through to the
                // passthrough branch below and is forwarded to bulletin-deploy
                // verbatim; deleting this arm would turn `--no-fallback` into a
                // silent passthrough flag and break any existing script/CI
                // invocation that still passes it. Keep it as a recognised,
                // explicit no-op.
                fallback = false;
                continue;
            case "--keep-staging":
                keepStaging = true;
                continue;
            case "--dry-run":
                dryRun = true;
                continue;
            case "-h":
            case "--help":
                throw new UsageError("help");
        }

        if (arg.startsWith("-")) {
            // Support `--dot=name` as well as `--dot name` for our own flags.
            const eq = arg.indexOf("=");
            if (eq > 0) {
                const name = arg.slice(0, eq);
                const value = arg.slice(eq + 1);
                if (name === "--dot" || name === "--domain") {
                    domain = value;
                    continue;
                }
                if (name === "--path" || name === "--source") {
                    source = value;
                    continue;
                }
                if (name === "--entry") {
                    entry = value;
                    continue;
                }
            }
            passthrough.push(arg);
            const next = argv[i + 1];
            if (next !== undefined && !next.startsWith("-") && eq < 0) {
                // Assume this unknown flag takes a value. See the doc comment.
                passthrough.push(next);
                i++;
            }
            continue;
        }

        if (source === null) {
            source = arg;
            continue;
        }
        throw new UsageError(
            `unexpected argument "${arg}" — the domain is a named parameter: --dot <name>`,
        );
    }

    if (source === null) throw new UsageError("a file or directory is required");
    if (domain === null) throw new UsageError("--dot <name> is required");

    return {
        source,
        domain: normaliseDomain(domain),
        entry,
        fallback,
        keepStaging,
        dryRun,
        passthrough,
    };
}

/**
 * `my-app` and `my-app.dot` both normalise to the bare label `my-app`.
 *
 * bulletin-deploy 0.15.0 made the TLD per-environment — `paseo-next-v2` (the
 * default) registers under `.paseo`; only `preview` still uses `.dot`; most
 * others carry no TLD at all in `assets/environments.json`. This tool has no
 * business reading that table and applying it itself: which environment is
 * even in play is decided by a passthrough `--env` flag this tool
 * deliberately does not parse (see `parseArgs`'s doc comment), so duplicating
 * bulletin-deploy's environment table here would just rot the moment a new
 * network is added upstream. Forwarding the bare label instead makes this
 * tool TLD-agnostic: bulletin-deploy resolves the correct suffix for whatever
 * `--env` was actually passed. Verified live: a bare `decentralize-ci` against
 * `paseo-next-v2` resolved to `decentralize-ci.paseo`, registered, and set the
 * contenthash — exactly what bulletin-deploy's own error message instructs
 * when handed a name with the wrong suffix.
 *
 * A trailing `.dot` is still stripped rather than forwarded literally, purely
 * for backward compatibility: every existing `--dot my-app.dot` invocation and
 * every example predating 0.15.0 spelled the suffix out, and stripping it
 * keeps all of those working unchanged. Anything else the caller types (e.g.
 * `my-app.paseo`, deliberately spelling out a different environment's suffix)
 * is forwarded byte-for-byte — this function does not know or guess what a
 * `.paseo` or any other suffix means, so it never invents or removes one on
 * your behalf.
 */
export function normaliseDomain(input: string): string {
    const trimmed = input.trim().replace(/\.$/, "");
    const label = trimmed.endsWith(".dot") ? trimmed.slice(0, -".dot".length) : trimmed;
    if (label === "") {
        throw new UsageError(`invalid --dot value: "${input}"`);
    }
    assertLabelIsPopRulesSafe(label);
    return label;
}

export function countTrailingDigits(label: string): number {
    return /\d*$/.exec(label)?.[0].length ?? 0;
}

/**
 * Reject a label that DotNS would rewrite rather than register.
 *
 * PopRules accepts exactly 0 or 2 trailing digits; anything else reverts
 * on-chain. bulletin-deploy's `sanitizeDomainLabel` therefore rewrites such
 * labels — and up to and including 0.13.x it did so on the registration path,
 * which SILENTLY RETARGETS the deploy at a different name (its issue #1189).
 * Observed live: `--dot spa-route-test3` became `spa-route-test`, an
 * already-owned live name (registered under `.dot`, the only TLD that
 * existed at the time), and the deploy went on to offer to overwrite its
 * content. The rewrite-onto-a-different-name hazard is independent of which
 * TLD is in play today.
 *
 * Newer bulletin-deploy refuses non-compliant labels outright, so erroring here
 * matches where upstream landed while also protecting anyone on an older
 * binary. No override flag, on purpose: the fix is to pick a compliant name.
 */
export function assertLabelIsPopRulesSafe(label: string): void {
    const trailing = countTrailingDigits(label);
    if (trailing === 0 || trailing === 2) return;

    let stripped = label;
    for (;;) {
        const next = stripped.replace(/\d+$/, "").replace(/-+$/, "");
        if (next === stripped) break;
        stripped = next;
    }
    let becomes = stripped;
    if (trailing > 2) {
        const candidate = stripped + label.slice(-2);
        if (countTrailingDigits(candidate) === 2) becomes = candidate;
    }

    throw new UsageError(
        `--dot "${label}" has ${trailing} trailing digit${trailing === 1 ? "" : "s"}; DotNS ` +
            `(PopRules) accepts exactly 0 or 2. bulletin-deploy would rewrite it to ` +
            `"${becomes}" instead of failing — on 0.13.x that silently retargets the ` +
            `deploy at a DIFFERENT name, overwriting it if you own it (its issue #1189). ` +
            `Use a label ending in a letter, or in exactly two digits (e.g. "${stripped}" ` +
            `or "${stripped}01").`,
    );
}

/** Root-level `*.html` filenames, sorted for determinism. */
function htmlFilesAt(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isFile() && /\.html?$/i.test(e.name))
        .map((e) => e.name)
        .sort();
}

/**
 * Breadth-first search for the shallowest directory containing an `index.html`,
 * so a build that wraps its output in one more folder still resolves. Returns
 * null when there is no index.html anywhere.
 */
export function findIndexHtmlRoot(root: string): string | null {
    const queue: string[] = [root];
    while (queue.length > 0) {
        const dir = queue.shift()!;
        if (existsSync(join(dir, "index.html"))) return dir;
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            if (entry.isDirectory()) queue.push(join(dir, entry.name));
        }
    }
    return null;
}

/**
 * Guarantee an `index.html` at the returned directory, renaming or hoisting as
 * needed. Operates on the STAGED copy — the caller's source tree is untouched.
 * Returns the directory to upload plus a human-readable log of what it did.
 */
export function resolveSpaRoot(
    stagingDir: string,
    explicitEntry: string | null,
): { uploadRoot: string; actions: string[] } {
    const actions: string[] = [];

    if (explicitEntry !== null) {
        const entryPath = resolve(stagingDir, explicitEntry);
        if (!existsSync(entryPath) || !statSync(entryPath).isFile()) {
            throw new UsageError(`--entry not found in the source: ${explicitEntry}`);
        }
        const root = dirname(entryPath);
        if (basename(entryPath) !== "index.html") {
            const target = join(root, "index.html");
            if (existsSync(target)) {
                throw new UsageError(
                    `--entry ${explicitEntry} cannot be renamed: index.html already exists beside it`,
                );
            }
            renameSync(entryPath, target);
            actions.push(`renamed ${explicitEntry} → index.html (--entry)`);
        }
        if (root !== stagingDir) {
            actions.push(`upload root is ${relative(stagingDir, root)}/ (--entry)`);
        }
        return { uploadRoot: root, actions };
    }

    // 1. index.html already at the root — nothing to do.
    if (existsSync(join(stagingDir, "index.html"))) {
        actions.push("index.html already at root");
        return { uploadRoot: stagingDir, actions };
    }

    // 2. A single .html at the root, or a recognisable entry name → rename it.
    const rootHtml = htmlFilesAt(stagingDir);
    if (rootHtml.length === 1) {
        renameSync(join(stagingDir, rootHtml[0]), join(stagingDir, "index.html"));
        actions.push(`renamed ${rootHtml[0]} → index.html (only .html at root)`);
        return { uploadRoot: stagingDir, actions };
    }
    if (rootHtml.length > 1) {
        const preferred = ENTRY_PREFERENCE.find((name) =>
            rootHtml.some((f) => f.toLowerCase() === name),
        );
        if (preferred === undefined) {
            throw new UsageError(
                `several .html files at the root and none is a recognisable entry ` +
                    `(${rootHtml.join(", ")}) — pick one with --entry <file>`,
            );
        }
        const actual = rootHtml.find((f) => f.toLowerCase() === preferred)!;
        renameSync(join(stagingDir, actual), join(stagingDir, "index.html"));
        actions.push(`renamed ${actual} → index.html (chose it from ${rootHtml.join(", ")})`);
        return { uploadRoot: stagingDir, actions };
    }

    // 3. No HTML at the root — hoist the shallowest nested index.html.
    const nested = findIndexHtmlRoot(stagingDir);
    if (nested !== null) {
        actions.push(`upload root is ${relative(stagingDir, nested)}/ (nested index.html)`);
        return { uploadRoot: nested, actions };
    }

    throw new UsageError(
        "no .html file found anywhere in the source — point this at a built static site (e.g. ./dist)",
    );
}

/**
 * Top-level staged entries that a re-rooted upload leaves behind.
 *
 * Re-rooting is the right call for relative asset paths — an entry at
 * `build/app.html` referencing `./assets/x.js` only resolves if `build/` is the
 * archive root — but it silently drops anything staged outside that directory.
 * We enumerate the casualties so the exclusion is never invisible.
 */
export function excludedByReroot(stagingDir: string, uploadRoot: string): string[] {
    if (uploadRoot === stagingDir) return [];
    const kept = relative(stagingDir, uploadRoot).split("/")[0];
    return readdirSync(stagingDir, { withFileTypes: true })
        .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
        .filter((name) => name.replace(/\/$/, "") !== kept)
        .sort();
}

/**
 * Opt-in insurance for plain Kubo gateways that honour these files — off by
 * default, since neither the Polkadot sandbox nor polkadot-desktop reads them,
 * and 404.html is a byte-identical copy of index.html that doubles the bytes
 * bulletin-deploy has to chunk and upload for no benefit on those targets
 * (see bulletin-deploy#1233). Never overwrites.
 */
export function writeFallbackFiles(uploadRoot: string): string[] {
    const actions: string[] = [];
    const notFound = join(uploadRoot, "404.html");
    if (existsSync(notFound)) {
        actions.push("404.html already present — left as-is");
    } else {
        cpSync(join(uploadRoot, "index.html"), notFound);
        actions.push("wrote 404.html (copy of index.html)");
    }
    const redirects = join(uploadRoot, "_redirects");
    if (existsSync(redirects)) {
        actions.push("_redirects already present — left as-is");
    } else {
        writeFileSync(redirects, REDIRECTS_BODY);
        actions.push("wrote _redirects (/* /index.html 200)");
    }
    return actions;
}

export interface StagedArchive {
    /** Temp directory the source was copied into. Caller removes it. */
    stagingDir: string;
    /** Directory to hand bulletin-deploy — holds index.html at its root. */
    uploadRoot: string;
    /** Human-readable log of every transformation applied. */
    actions: string[];
    /** Top-level entries a re-root excluded from the archive. */
    excluded: string[];
}

/**
 * Copy `source` into a fresh temp directory and make it a valid SPA archive.
 * Never mutates `source`.
 */
export function stageArchive(options: {
    source: string;
    entry: string | null;
    fallback: boolean;
}): StagedArchive {
    const sourceAbs = resolve(options.source);
    if (!existsSync(sourceAbs)) throw new UsageError(`not found: ${sourceAbs}`);

    const isDirectory = statSync(sourceAbs).isDirectory();
    const stagingDir = mkdtempSync(join(tmpdir(), "decentralize-"));
    const actions: string[] = [];
    let uploadRoot: string;

    if (isDirectory) {
        const skipped = new Set<string>();
        cpSync(sourceAbs, stagingDir, {
            recursive: true,
            filter: (src) => {
                const name = basename(src);
                if (EXCLUDED_FROM_ARCHIVE.includes(name)) {
                    skipped.add(name);
                    return false;
                }
                return true;
            },
        });
        if (skipped.size > 0) {
            actions.push(`excluded from the archive: ${[...skipped].sort().join(", ")}`);
        }
        const resolved = resolveSpaRoot(stagingDir, options.entry);
        uploadRoot = resolved.uploadRoot;
        actions.push(...resolved.actions);
    } else {
        // Single file: it IS the app, whatever it was called.
        cpSync(sourceAbs, join(stagingDir, "index.html"));
        uploadRoot = stagingDir;
        const name = basename(sourceAbs);
        actions.push(
            name === "index.html"
                ? "copied index.html"
                : `copied ${name} → index.html (single-file app)`,
        );
    }

    if (options.fallback) actions.push(...writeFallbackFiles(uploadRoot));

    return {
        stagingDir,
        uploadRoot,
        actions,
        excluded: excludedByReroot(stagingDir, uploadRoot),
    };
}

/** Recursive relative-path listing, for the plan preview. */
export function listTree(root: string): string[] {
    const out: string[] = [];
    const walk = (dir: string) => {
        for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
            a.name.localeCompare(b.name),
        )) {
            const abs = join(dir, entry.name);
            if (entry.isDirectory()) walk(abs);
            else out.push(relative(root, abs));
        }
    };
    walk(root);
    return out;
}
