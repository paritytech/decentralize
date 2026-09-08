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

export default defineConfig({
    test: {
        include: ["src/**/*.test.ts"],
        // Prints which bulletin-deploy is installed, its channel, and what
        // package.json pins — before ANY test runs, in this suite too (not
        // only e2e/): a stale `node_modules/bulletin-deploy` after a pin
        // bump is worth flagging here as well. See e2e/bulletin-version.ts
        // for why this is safe to do in a suite that must stay hermetic.
        globalSetup: ["./e2e/bulletin-version.ts"],
    },
});
