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
 * Unit tests for the version-banner helper's pure logic. The helper itself
 * lives in `e2e/bulletin-version.ts`, not `src/`, because it is wired as
 * `globalSetup` for BOTH `vitest.config.ts` (this suite) and
 * `vitest.e2e.config.ts` — but `vitest.config.ts` only collects
 * `src/**\/*.test.ts` (see that file), so its tests live here rather than
 * next to the implementation.
 *
 * Only the pure formatting/decision functions are covered — the actual
 * filesystem reads (`resolveBulletinVersionInfo`) are deliberately NOT
 * exercised with fs mocking here; they are a thin, un-clever pass-through
 * that either reads a real installed/declared version or falls back to
 * "unknown", and that fallback is exactly what makes them safe to leave
 * uncovered by a unit test that would otherwise need to fake a
 * node_modules layout.
 */

import { describe, expect, it } from "vitest";
import { formatBulletinVersionBanner, resolveChannel } from "../e2e/bulletin-version.js";

describe("formatBulletinVersionBanner", () => {
    it("names installed version, channel, and the package.json pin together", () => {
        expect(
            formatBulletinVersionBanner({ installed: "0.17.0", declared: "0.17.0", channel: "latest" }),
        ).toBe("▸ bulletin-deploy@0.17.0 (channel: latest; package.json pins 0.17.0)");
    });

    it("makes drift between installed and declared visible, not just the numbers", () => {
        // The whole point of the banner: a reader must be able to tell, at a
        // glance and without doing version arithmetic, that the run exercised
        // a DIFFERENT bulletin-deploy than the one package.json pins.
        const banner = formatBulletinVersionBanner({
            installed: "0.18.0",
            declared: "0.17.0",
            channel: "latest",
        });
        expect(banner).toContain("0.18.0");
        expect(banner).toContain("0.17.0");
    });

    it("prints the pinned channel unchanged", () => {
        expect(
            formatBulletinVersionBanner({ installed: "0.17.0", declared: "0.17.0", channel: "pinned" }),
        ).toBe("▸ bulletin-deploy@0.17.0 (channel: pinned; package.json pins 0.17.0)");
    });

    it("prints an explicit 'unknown' rather than throwing or going blank", () => {
        expect(
            formatBulletinVersionBanner({ installed: "unknown", declared: "unknown", channel: "pinned" }),
        ).toBe("▸ bulletin-deploy@unknown (channel: pinned; package.json pins unknown)");
    });
});

describe("resolveChannel", () => {
    it("reads 'latest' from BULLETIN_DEPLOY_CHANNEL", () => {
        expect(resolveChannel("latest")).toBe("latest");
    });

    it("defaults to 'pinned' when unset", () => {
        expect(resolveChannel(undefined)).toBe("pinned");
    });

    it("defaults to 'pinned' on any other/unrecognised value, rather than propagating a typo silently", () => {
        expect(resolveChannel("")).toBe("pinned");
        expect(resolveChannel("Latest")).toBe("pinned");
        expect(resolveChannel("stable")).toBe("pinned");
    });
});
