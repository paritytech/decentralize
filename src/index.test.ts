// Copyright (C) Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

/**
 * Unit tests for the pure logic in index.ts. The three exported helpers are the
 * parts with real branching; the deploy itself is a passthrough to
 * bulletin-deploy and is covered by running it, not by mocks.
 *
 * `resolveSpaRoot` mutates the directory it is given (it renames the entry), so
 * every case builds a throwaway tree under a fresh mkdtemp.
 */

import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
    listTree,
    normaliseDomain,
    parseArgs,
    resolveSpaRoot,
    stageArchive,
    UsageError,
} from "./index.js";

const created: string[] = [];

/** Build a temp tree from a {relativePath: contents} map. */
function tree(files: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), "decentralize-test-"));
    created.push(dir);
    for (const [path, contents] of Object.entries(files)) {
        const abs = join(dir, path);
        mkdirSync(join(abs, ".."), { recursive: true });
        writeFileSync(abs, contents);
    }
    return dir;
}

afterEach(() => {
    while (created.length > 0) rmSync(created.pop()!, { recursive: true, force: true });
});

describe("normaliseDomain", () => {
    it("appends .dot to a bare label", () => {
        expect(normaliseDomain("my-app")).toBe("my-app.dot");
    });

    it("leaves an already-suffixed name alone rather than doubling it", () => {
        expect(normaliseDomain("my-app.dot")).toBe("my-app.dot");
    });

    it("tolerates surrounding whitespace and a trailing dot", () => {
        expect(normaliseDomain("  my-app.dot.  ")).toBe("my-app.dot");
        expect(normaliseDomain(" my-app ")).toBe("my-app.dot");
    });

    it("rejects values that would normalise to nothing", () => {
        expect(() => normaliseDomain("")).toThrow(/invalid --dot/);
        expect(() => normaliseDomain(".dot")).toThrow(/invalid --dot/);
    });
});

describe("parseArgs", () => {
    it("takes the source positionally and the domain as a named parameter", () => {
        const args = parseArgs(["./dist", "--dot", "my-app"]);
        expect(args.source).toBe("./dist");
        expect(args.domain).toBe("my-app.dot");
        expect(args.passthrough).toEqual([]);
    });

    it("accepts --path and --domain as aliases, and the --flag=value form", () => {
        expect(parseArgs(["--path", "./dist", "--domain", "x"]).source).toBe("./dist");
        expect(parseArgs(["--path=./dist", "--dot=x"])).toMatchObject({
            source: "./dist",
            domain: "x.dot",
        });
    });

    it("requires both a source and a domain", () => {
        expect(() => parseArgs(["--dot", "my-app"])).toThrow(/file or directory is required/);
        expect(() => parseArgs(["./dist"])).toThrow(/--dot <name> is required/);
    });

    it("rejects a second positional, pointing at the named parameter", () => {
        // Guards the bulletin-deploy muscle memory of `<dir> <domain.dot>`.
        expect(() => parseArgs(["./dist", "my-app.dot"])).toThrow(/--dot <name>/);
    });

    it("forwards unknown flags, picking up a following value", () => {
        const args = parseArgs(["./dist", "--dot", "x", "--env", "summit", "--publish"]);
        expect(args.passthrough).toEqual(["--env", "summit", "--publish"]);
    });

    it("forwards everything after a bare -- verbatim", () => {
        const args = parseArgs(["./dist", "--dot", "x", "--", "--js-merkle", "--pool-size", "4"]);
        expect(args.passthrough).toEqual(["--js-merkle", "--pool-size", "4"]);
    });

    it("does not swallow the source into a preceding boolean passthrough flag", () => {
        // The lookahead heuristic's known failure mode; `--path` is the escape.
        const args = parseArgs(["--path", "./dist", "--dot", "x", "--publish"]);
        expect(args.source).toBe("./dist");
        expect(args.passthrough).toEqual(["--publish"]);
    });

    it("parses its own boolean flags without forwarding them", () => {
        const args = parseArgs([
            "./dist",
            "--dot",
            "x",
            "--no-fallback",
            "--keep-staging",
            "--dry-run",
        ]);
        expect(args).toMatchObject({ fallback: false, keepStaging: true, dryRun: true });
        expect(args.passthrough).toEqual([]);
    });

    it("errors when a value-taking flag is last or followed by another flag", () => {
        expect(() => parseArgs(["./dist", "--dot"])).toThrow(/--dot requires a value/);
        expect(() => parseArgs(["./dist", "--dot", "--publish"])).toThrow(/--dot requires a value/);
    });
});

describe("resolveSpaRoot", () => {
    it("leaves an existing root index.html in place", () => {
        const dir = tree({ "index.html": "<h1>hi</h1>", "assets/a.css": "" });
        const { uploadRoot, actions } = resolveSpaRoot(dir, null);
        expect(uploadRoot).toBe(dir);
        expect(actions.join(" ")).toMatch(/already at root/);
    });

    it("renames a lone root .html to index.html", () => {
        const dir = tree({ "main.html": "<h1>hi</h1>", "assets/a.js": "" });
        const { uploadRoot } = resolveSpaRoot(dir, null);
        expect(uploadRoot).toBe(dir);
        expect(existsSync(join(dir, "index.html"))).toBe(true);
        expect(existsSync(join(dir, "main.html"))).toBe(false);
        // Siblings must survive the rename.
        expect(existsSync(join(dir, "assets/a.js"))).toBe(true);
    });

    it("picks a recognisable entry when several .html sit at the root", () => {
        const dir = tree({ "app.html": "x", "styleguide.html": "y" });
        const { actions } = resolveSpaRoot(dir, null);
        expect(existsSync(join(dir, "index.html"))).toBe(true);
        expect(actions.join(" ")).toMatch(/renamed app\.html/);
    });

    it("refuses to guess between several unrecognisable .html files", () => {
        const dir = tree({ "foo.html": "x", "bar.html": "y" });
        expect(() => resolveSpaRoot(dir, null)).toThrow(/--entry/);
    });

    it("hoists the shallowest nested index.html when the root has no html", () => {
        const dir = tree({ "build/index.html": "x", "build/assets/a.js": "" });
        const { uploadRoot } = resolveSpaRoot(dir, null);
        expect(uploadRoot).toBe(join(dir, "build"));
    });

    it("throws when there is no html anywhere", () => {
        const dir = tree({ "readme.txt": "x" });
        expect(() => resolveSpaRoot(dir, null)).toThrow(/no \.html file found/);
    });

    it("honours an explicit --entry at the root", () => {
        const dir = tree({ "foo.html": "x", "bar.html": "y" });
        const { uploadRoot } = resolveSpaRoot(dir, "bar.html");
        expect(uploadRoot).toBe(dir);
        expect(existsSync(join(dir, "index.html"))).toBe(true);
        expect(existsSync(join(dir, "foo.html"))).toBe(true);
    });

    it("re-roots for a nested --entry so relative asset paths still resolve", () => {
        const dir = tree({ "build/app.html": "x", "build/assets/a.js": "", "favicon.ico": "" });
        const { uploadRoot } = resolveSpaRoot(dir, "build/app.html");
        expect(uploadRoot).toBe(join(dir, "build"));
        expect(existsSync(join(dir, "build/index.html"))).toBe(true);
    });

    it("rejects an --entry that does not exist", () => {
        const dir = tree({ "index.html": "x" });
        expect(() => resolveSpaRoot(dir, "nope.html")).toThrow(/--entry not found/);
    });

    it("refuses to clobber an index.html that already sits beside the --entry", () => {
        const dir = tree({ "index.html": "real", "other.html": "x" });
        expect(() => resolveSpaRoot(dir, "other.html")).toThrow(/already exists beside it/);
    });
});

describe("assertLabelIsPopRulesSafe (via normaliseDomain)", () => {
    it("accepts a label ending in a letter", () => {
        expect(normaliseDomain("my-app")).toBe("my-app.dot");
    });

    it("accepts exactly two trailing digits", () => {
        expect(normaliseDomain("my-app01")).toBe("my-app01.dot");
    });

    it("rejects one trailing digit, naming what it would silently become", () => {
        // The live near-miss: spa-route-test3 → spa-route-test.dot (#1189).
        expect(() => normaliseDomain("spa-route-test3")).toThrow(/spa-route-test\.dot/);
        expect(() => normaliseDomain("spa-route-test3")).toThrow(/1 trailing digit;/);
    });

    it("rejects three or more trailing digits", () => {
        expect(() => normaliseDomain("my-app123")).toThrow(/3 trailing digits/);
        // >2 keeps the last two, mirroring sanitizeDomainLabel.
        expect(() => normaliseDomain("my-app123")).toThrow(/my-app23\.dot/);
    });

    it("strips a dangling hyphen when suggesting alternatives", () => {
        expect(() => normaliseDomain("my-app-1")).toThrow(/"my-app"/);
    });
});

describe("stageArchive", () => {
    it("never mutates the source and yields index.html at the upload root", () => {
        const src = tree({ "main.html": "<h1>hi</h1>", "assets/a.js": "" });
        const staged = stageArchive({ source: src, entry: null, fallback: true });
        created.push(staged.stagingDir);

        // Source is untouched — the rename happened on the copy.
        expect(existsSync(join(src, "main.html"))).toBe(true);
        expect(existsSync(join(src, "index.html"))).toBe(false);

        expect(existsSync(join(staged.uploadRoot, "index.html"))).toBe(true);
        expect(existsSync(join(staged.uploadRoot, "assets/a.js"))).toBe(true);
        expect(staged.excluded).toEqual([]);
    });

    it("treats a single file as the app entry whatever its name", () => {
        const dir = tree({ "whatever.html": "<h1>solo</h1>" });
        const staged = stageArchive({
            source: join(dir, "whatever.html"),
            entry: null,
            fallback: false,
        });
        created.push(staged.stagingDir);
        expect(listTree(staged.uploadRoot)).toEqual(["index.html"]);
    });

    it("writes the fallback files only when asked", () => {
        const dir = tree({ "index.html": "x" });
        const withFallback = stageArchive({ source: dir, entry: null, fallback: true });
        created.push(withFallback.stagingDir);
        expect(listTree(withFallback.uploadRoot).sort()).toEqual(["404.html", "_redirects", "index.html"]);

        const without = stageArchive({ source: dir, entry: null, fallback: false });
        created.push(without.stagingDir);
        expect(listTree(without.uploadRoot)).toEqual(["index.html"]);
    });

    it("reports what a re-rooted upload excludes instead of dropping it silently", () => {
        const dir = tree({ "build/app.html": "x", "favicon.ico": "", "docs/readme.md": "" });
        const staged = stageArchive({ source: dir, entry: "build/app.html", fallback: false });
        created.push(staged.stagingDir);
        expect(staged.excluded).toEqual(["docs/", "favicon.ico"]);
    });

    it("throws a UsageError for a missing source", () => {
        expect(() => stageArchive({ source: "/nope/missing", entry: null, fallback: true })).toThrow(
            UsageError,
        );
    });
});

describe("archive exclusions", () => {
    it("never publishes .git, .bulletin-deploy, node_modules or .DS_Store", () => {
        const dir = tree({
            "index.html": "x",
            ".git/config": "[core]",
            ".bulletin-deploy/manifest.json": "{}",
            "node_modules/dep/index.js": "",
            ".DS_Store": "",
            "assets/keep.js": "// real content",
        });
        const staged = stageArchive({ source: dir, entry: null, fallback: false });
        created.push(staged.stagingDir);

        expect(listTree(staged.uploadRoot).sort()).toEqual(["assets/keep.js", "index.html"]);
        expect(staged.actions.join(" ")).toMatch(/excluded from the archive/);
    });

    it("says nothing about exclusions when there is nothing to exclude", () => {
        const dir = tree({ "index.html": "x" });
        const staged = stageArchive({ source: dir, entry: null, fallback: false });
        created.push(staged.stagingDir);
        expect(staged.actions.join(" ")).not.toMatch(/excluded/);
    });
});
