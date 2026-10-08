import { call, run } from "effection";
import { describe, expect, test } from "vitest";

import { plain } from "../tests/support/fixture.js";
import { expand, matches, sources, supported } from "./sources.js";

const typescript = [".ts", ".tsx", ".cts", ".mts", ".svelte"];

function inventory(files: string[], excluded: string[] = []) {
  return { files, excluded };
}

describe("matches", () => {
  test.for([
    ["src/**/*.ts", "src/a.ts", true],
    ["src/**/*.ts", "src/deep/er/a.ts", true],
    ["src/*.ts", "src/deep/a.ts", false],
    ["**/*.ts", "a.ts", true],
    ["*.config.ts", "vite.config.ts", true],
    ["src/**", "src/a/b.css", true],
    ["src/a.ts", "src/a.ts", true],
    ["src/a.ts", "src/b.ts", false],
  ] as const)("%s against %s is %s", ([pattern, file, expected]) =>
    run(function* () {
      yield* call(() => {
        expect(matches(pattern, file)).toBe(expected);
      });
    }),
  );

  test.for([
    ["src/**/*.ts", true],
    ["a.ts", true],
    ["*", true],
    ["src/?.ts", false],
    ["src/[ab].ts", false],
    ["{a,b}.ts", false],
    ["src/a**.ts", false],
    ["../a.ts", false],
    ["/a.ts", false],
  ] as const)("%s is supported: %s", ([pattern, expected]) =>
    run(function* () {
      yield* call(() => {
        expect(supported(pattern)).toBe(expected);
      });
    }),
  );

  test("expands a glob over an inventory with excludes", () =>
    run(function* () {
      yield* call(() => {
        expect(
          expand(["src/a.ts", "src/a.test.ts", "b.ts"], ["src/**/*.ts"], ["src/**/*.test.ts"]),
        ).toEqual(["src/a.ts"]);
      });
    }));
});

describe("sources", () => {
  test("emits the configuration's glob when it selects exactly the set", () =>
    run(function* () {
      yield* call(() => {
        const files = ["src/a.ts", "src/b.test.ts", "src/deep/c.ts", "vite.config.ts", "README.md"];
        const value = sources(["src/a.ts", "src/deep/c.ts", "vite.config.ts"], inventory(files), {
          include: ["src/**/*.ts", "vite.config.ts"],
          exclude: ["src/**/*.test.ts"],
          extensions: typescript,
        });
        expect(plain(value)).toEqual({
          concatenation: [
            ["vite.config.ts"],
            { glob: ["src/**/*.ts"], exclude: ["src/**/*.test.ts"], allowEmpty: false },
          ],
        });
      });
    }));

  test("expands extensionless wildcards to the extensions in use", () =>
    run(function* () {
      yield* call(() => {
        const files = ["src/a.ts", "src/b.svelte", "src/c.css"];
        const value = sources(["src/a.ts", "src/b.svelte"], inventory(files), {
          include: ["src"],
          exclude: [],
          extensions: typescript,
        });
        expect(plain(value)).toEqual({
          glob: ["src/**/*.svelte", "src/**/*.ts"],
          exclude: [],
          allowEmpty: false,
        });
      });
    }));

  test("allows an authored pattern that matches nothing yet", () =>
    run(function* () {
      yield* call(() => {
        const value = sources(["src/a.ts"], inventory(["src/a.ts"]), {
          include: ["src/**/*.ts", "tests/**/*.ts"],
          exclude: [],
          extensions: typescript,
        });
        expect(plain(value)).toEqual({
          glob: ["src/**/*.ts", "tests/**/*.ts"],
          exclude: [],
          allowEmpty: true,
        });
      });
    }));

  test("keeps exclusions that overlap the glob and drops unrelated ones", () =>
    run(function* () {
      yield* call(() => {
        const value = sources(["src/a.ts"], inventory(["src/a.ts", "src/a.test.ts"]), {
          include: ["src/**/*.ts"],
          exclude: ["src/**/*.test.ts", "scripts/**", "dist"],
          extensions: typescript,
        });
        expect(plain(value)).toEqual({
          glob: ["src/**/*.ts"],
          exclude: ["src/**/*.test.ts"],
          allowEmpty: false,
        });
      });
    }));

  test.for([
    {
      name: "the glob selects a file outside the set",
      files: ["src/a.ts", "src/b.ts"],
      set: ["src/a.ts"],
      excluded: [],
    },
    {
      name: "a Gazelle-excluded path falls under the glob",
      files: ["src/a.ts"],
      set: ["src/a.ts"],
      excluded: ["src/generated"],
    },
    {
      name: "a wildcard reaches a hidden name",
      files: ["src/.cache/a.ts"],
      set: ["src/.cache/a.ts"],
      excluded: [],
    },
  ])("lists files explicitly when $name", ({ files, set, excluded }) =>
    run(function* () {
      yield* call(() => {
        const value = sources(set, inventory(files, excluded), {
          include: ["src/**/*.ts"],
          exclude: [],
          extensions: typescript,
        });
        expect(plain(value)).toEqual(set);
      });
    }),
  );

  test("a wildcard matches names with bracket and brace characters", () =>
    run(function* () {
      yield* call(() => {
        const files = ["src/routes/[organization]/+page.ts", "src/routes/{group}/a.ts", "src/a.ts"];
        const value = sources(files, inventory(files), {
          include: ["src/**/*.ts", "src/routes/[organization]/extra.d.ts"],
          exclude: [],
          extensions: typescript,
        });
        expect(plain(value)).toEqual({ glob: ["src/**/*.ts"], exclude: [], allowEmpty: false });
      });
    }));

  test.for([
    { name: "an include", include: ["src/[organization]/*.ts"], exclude: [] },
    { name: "an include directory", include: ["src/{a,b}"], exclude: [] },
    { name: "an exclusion", include: ["src/**/*.ts"], exclude: ["src/[organization]/*.test.ts"] },
  ])("lists files when $name pattern would contain a metacharacter", ({ include, exclude }) =>
    run(function* () {
      yield* call(() => {
        const files = ["src/[organization]/a.ts"];
        expect(
          plain(sources(files, inventory(files), { include, exclude, extensions: typescript })),
        ).toEqual(files);
      });
    }),
  );

  test("ignores directories Bazel never globs, which the inventory omits", () =>
    run(function* () {
      yield* call(() => {
        // node_modules is ignored by Bazel itself, so it is neither a file of
        // the inventory nor an excluded path.
        const value = sources(["src/a.ts"], inventory(["src/a.ts"]), {
          include: ["**/*.ts"],
          exclude: [],
          extensions: typescript,
        });
        expect(plain(value)).toEqual({ glob: ["**/*.ts"], exclude: [], allowEmpty: false });
      });
    }));

  test("emits the glob when an exclusion covers the excluded path", () =>
    run(function* () {
      yield* call(() => {
        const value = sources(["src/a.ts"], inventory(["src/a.ts"], ["src/generated"]), {
          include: ["src/**/*.ts"],
          exclude: ["src/generated"],
          extensions: typescript,
        });
        expect(plain(value)).toEqual({
          glob: ["src/**/*.ts"],
          exclude: ["src/generated/**"],
          allowEmpty: false,
        });
      });
    }));

  test("a literal exclusion excludes the file or directory a glob could select", () =>
    run(function* () {
      yield* call(() => {
        const files = ["a.ts", "skip.ts", "dist/b.ts"];
        const value = sources(["a.ts"], inventory(files), {
          include: ["**/*.ts"],
          exclude: ["skip.ts", "dist", "other/file.css"],
          extensions: typescript,
        });
        expect(plain(value)).toEqual({
          glob: ["**/*.ts"],
          exclude: ["dist/**", "skip.ts"],
          allowEmpty: false,
        });
      });
    }));

  test("lists files without configuration patterns or with unsupported syntax", () =>
    run(function* () {
      yield* call(() => {
        expect(plain(sources(["b.ts", "a.ts"], inventory(["a.ts", "b.ts"])))).toEqual([
          "a.ts",
          "b.ts",
        ]);
        const value = sources(["a.ts"], inventory(["a.ts"]), {
          include: ["?.ts"],
          exclude: [],
          extensions: typescript,
        });
        expect(plain(value)).toEqual(["a.ts"]);
      });
    }));
});
