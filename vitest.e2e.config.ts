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

import { defineConfig } from "vitest/config";

/**
 * A SEPARATE config from vitest.config.ts, on purpose: `vitest.config.ts`
 * must stay hermetic and offline (`include: ["src/**\/*.test.ts"]` only), so
 * that `npm test` — the check every PR runs — can never reach the chain. This
 * file is only ever invoked explicitly via `npm run test:e2e`.
 * See docs-internal/superpowers/specs/2026-08-10-e2e-chain-validation-design.md
 * ("Placement and isolation").
 */
export default defineConfig({
    test: {
        include: ["e2e/**/*.e2e.test.ts"],
        // Each case makes a real Paseo Next v2 deploy (~2 minutes of wall time
        // per the design doc) plus a gateway roundtrip with its own budget.
        // 300s leaves headroom for RPC/gateway propagation delay without
        // masking a genuinely hung run.
        testTimeout: 300_000,
        hookTimeout: 60_000,
        // Prints which bulletin-deploy is installed, its channel (pinned vs
        // the nightly's latest-on-top install — see .github/workflows/e2e.yml),
        // and what package.json pins. A red e2e run has three possible causes
        // — upstream regression, chain drift, or our own staleness — and this
        // banner is the first thing that separates them.
        globalSetup: ["./e2e/bulletin-version.ts"],
    },
});
