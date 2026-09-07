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
 * Prints, at the top of every vitest run, exactly which bulletin-deploy was
 * exercised — installed version, channel, and the version package.json pins.
 *
 * Why this exists: the nightly e2e workflow installs `bulletin-deploy@latest`
 * ON TOP OF the pinned dependency (see .github/workflows/e2e.yml) so upstream
 * ABI drift is caught the night it lands, while `package.json` itself keeps a
 * known-good pin for end users. That means "installed" and "declared" can
 * legitimately differ, and a red run's FIRST diagnostic question is always
 * "which bulletin-deploy actually ran" — this banner answers that without
 * anyone having to go dig through an `npm install` log.
 *
 * Wired as `globalSetup` in BOTH vitest.config.ts and vitest.e2e.config.ts:
 * the pinned unit suite gets the drift signal too, not only e2e, because a
 * stale local `node_modules/bulletin-deploy` (forgot to `npm install` after a
 * pin bump) is just as worth surfacing there.
 *
 * HERMETIC BY CONSTRUCTION: this module only ever reads two package.json
 * files already sitting on disk. It must NOT import `bulletin-deploy` itself,
 * spawn anything, or touch the network — `vitest.config.ts` documents itself
 * as hermetic/offline specifically so `npm test` can never reach the chain,
 * and a version-banner helper is not a good reason to break that property.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const UNKNOWN = "unknown";

export interface BulletinVersionInfo {
    /** Version read from node_modules/bulletin-deploy/package.json, or "unknown". */
    installed: string;
    /** Version declared in this repo's own package.json dependencies, or "unknown". */
    declared: string;
    /** Resolved from BULLETIN_DEPLOY_CHANNEL — "latest" or "pinned" (the default). */
    channel: string;
}

/**
 * BULLETIN_DEPLOY_CHANNEL is read as an explicit allowlist rather than
 * "anything non-empty means latest": a typo'd value (e.g. "Latest") should
 * fall back to the safe, existing "pinned" behaviour rather than silently
 * flipping bootstrap.sh's channel-aware check into its more permissive mode.
 */
export function resolveChannel(envValue: string | undefined): string {
    return envValue === "latest" ? "latest" : "pinned";
}

function readVersionField(path: string): string {
    try {
        const parsed = JSON.parse(readFileSync(path, "utf8")) as { version?: string };
        return typeof parsed.version === "string" && parsed.version !== "" ? parsed.version : UNKNOWN;
    } catch {
        return UNKNOWN;
    }
}

function readDeclaredBulletinVersion(repoPackageJsonPath: string): string {
    try {
        const parsed = JSON.parse(readFileSync(repoPackageJsonPath, "utf8")) as {
            dependencies?: Record<string, string>;
        };
        const declared = parsed.dependencies?.["bulletin-deploy"];
        return typeof declared === "string" && declared !== "" ? declared : UNKNOWN;
    } catch {
        return UNKNOWN;
    }
}

/**
 * Walk up from this file looking for the repo root (a directory holding both
 * `package.json` and `node_modules`), the same shape as cli.ts's
 * `findDependencyManifest` — this handles being invoked from either vitest
 * config regardless of the process's current working directory. Falls back
 * to `process.cwd()` if no such ancestor is found, rather than throwing: a
 * banner must never be the reason a suite fails.
 */
function findRepoRoot(): string {
    let dir = dirname(fileURLToPath(import.meta.url));
    for (;;) {
        if (existsSync(join(dir, "package.json")) && existsSync(join(dir, "node_modules"))) {
            return dir;
        }
        const parent = dirname(dir);
        if (parent === dir) return process.cwd();
        dir = parent;
    }
}

export function resolveBulletinVersionInfo(repoRoot: string = findRepoRoot()): BulletinVersionInfo {
    return {
        installed: readVersionField(join(repoRoot, "node_modules", "bulletin-deploy", "package.json")),
        declared: readDeclaredBulletinVersion(join(repoRoot, "package.json")),
        channel: resolveChannel(process.env.BULLETIN_DEPLOY_CHANNEL),
    };
}

export function formatBulletinVersionBanner(info: BulletinVersionInfo): string {
    return `▸ bulletin-deploy@${info.installed} (channel: ${info.channel}; package.json pins ${info.declared})`;
}

/**
 * vitest `globalSetup` entry point. Wrapped in its own try/catch as a second
 * line of defense on top of the already-fallback-safe functions above —
 * belt and braces, because the one thing worse than a wrong banner is a
 * banner that takes the whole suite down with it.
 */
export default function globalSetup(): void {
    try {
        console.log(formatBulletinVersionBanner(resolveBulletinVersionInfo()));
    } catch (err) {
        console.log(
            `▸ bulletin-deploy@${UNKNOWN} (channel: ${UNKNOWN}; package.json pins ${UNKNOWN}) — banner failed: ${
                err instanceof Error ? err.message : String(err)
            }`,
        );
    }
}
