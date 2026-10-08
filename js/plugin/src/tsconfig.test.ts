import { Code, ConnectError } from "@connectrpc/connect";
import { call, ensure, run } from "effection";
import { describe, expect, test } from "vitest";

import { rule, useFixture } from "../tests/support/fixture.js";
import type { Rule } from "./generated/gazelle/v1/language_pb.js";
import {
  compilerOptions,
  discoverProjects,
  projectOutputs,
  projectPatterns,
  projectRole,
} from "./tsconfig.js";
import { strings } from "./values.js";

describe("discoverProjects", () => {
  test("package-root configs are entries and configs they extend in the package provide options", () =>
    run(function* () {
      const fixture = yield* useFixture();
      const projects = discoverProjects(fixture.pkg("app"), []);
      expect(
        projects.map(({ kind, local, name, entry, compilations }) => ({
          kind,
          local,
          name,
          entry,
          compilations,
        })),
      ).toEqual([
        {
          kind: "js_svelte_kit",
          local: "node_modules/$app/tsconfig.json",
          name: "kit",
          entry: false,
          compilations: [],
        },
        {
          kind: "js_tsconfig",
          local: "tsconfig.json",
          name: "tsconfig",
          entry: true,
          compilations: ["tsc"],
        },
      ]);
    }));

  test("SvelteKit's generated configuration keeps an existing js_svelte_kit's name, never a js_tsconfig's", () =>
    run(function* () {
      const fixture = yield* useFixture();
      const kit = (rules: Rule[]) =>
        discoverProjects(fixture.pkg("app", rules), []).find(
          (item) => item.local === "node_modules/$app/tsconfig.json",
        );
      expect(kit([rule("js_svelte_kit", "sync", {})])).toMatchObject({
        kind: "js_svelte_kit",
        name: "sync",
      });
      expect(
        kit([rule("js_tsconfig", "kit_tsconfig", { config: "node_modules/$app/tsconfig.json" })]),
      ).toMatchObject({ kind: "js_svelte_kit", name: "kit" });
    }));

  test("SvelteKit's generated configuration is a project only while a config extends it", () =>
    run(function* () {
      const fixture = yield* useFixture({
        "app/tsconfig.json": JSON.stringify({
          extends: "../tsconfig.base.json",
          include: ["src/**/*.ts"],
        }),
      });
      const projects = discoverProjects(fixture.pkg("app", [rule("js_svelte_kit", "kit", {})]), []);
      expect(projects.map((item) => item.local)).toEqual(["tsconfig.json"]);
    }));

  test.each([
    [undefined, "`svelte-kit sync` in //app to create the first js_svelte_kit rule"],
    ["kit", "`bazel run //app:kit_write`"],
    ["sync", "`bazel run //app:sync_write`"],
  ])("an unsynced checkout names its SvelteKit command (%s)", (name, command) =>
    run(function* () {
      const fixture = yield* useFixture();
      fixture.remove("app/node_modules/$app");
      let failure: unknown;
      try {
        discoverProjects(fixture.pkg("app", name ? [rule("js_svelte_kit", name, {})] : []), []);
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(ConnectError);
      expect(failure).toMatchObject({ code: Code.InvalidArgument });
      expect((failure as ConnectError).rawMessage).toBe(
        `app/tsconfig.json: reads app/node_modules/$app/tsconfig.json, which this checkout has not generated; run ${command}`,
      );
    }),
  );

  test("projects record the configurations their own extends names", () =>
    run(function* () {
      const fixture = yield* useFixture();
      const pkg = fixture.pkg("lib");
      const projects = discoverProjects(pkg, []);
      const bases = Object.fromEntries(
        projects.map((item) => [
          item.local,
          item.bases.map((file) => pkg.workspace.relative(file)),
        ]),
      );
      expect(bases).toEqual({
        "tsconfig.json": ["lib/tsconfig.test.json"],
        "tsconfig.lib.json": ["tsconfig.base.json"],
        "tsconfig.test.json": ["lib/tsconfig.lib.json"],
      });
    }));

  test("existing rules keep their names and compilations", (context) =>
    run(function* () {
      const started = performance.now();
      const phases: { completed: string; milliseconds: number }[] = [];
      context.onTestFailed(() => {
        console.error("Project discovery timings:", phases);
      });
      yield* ensure(() => {
        phases.push({ completed: "fixture cleanup", milliseconds: performance.now() - started });
      });
      const fixture = yield* useFixture(
        { "lib/configs/check.json": '{"extends": "../tsconfig.lib.json"}' },
        (completed) => {
          phases.push({ completed, milliseconds: performance.now() - started });
        },
      );
      phases.push({ completed: "fixture setup", milliseconds: performance.now() - started });
      const pkg = fixture.pkg("lib", [
        rule("js_tsconfig", "library", { config: "tsconfig.lib.json" }),
        rule("js_tsc", "compile", { config: ":library" }),
        rule("js_tsc", "check", { config: "//lib:library" }),
        rule("js_tsconfig", "checked", { config: ":configs/check.json" }),
      ]);
      phases.push({ completed: "package inventory", milliseconds: performance.now() - started });
      const projects = discoverProjects(pkg, []);
      phases.push({ completed: "project discovery", milliseconds: performance.now() - started });
      expect(projects.map(({ local, name, compilations }) => [local, name, compilations])).toEqual([
        ["configs/check.json", "checked", ["check_tsc"]],
        ["tsconfig.json", "tsconfig", ["tsc"]],
        ["tsconfig.lib.json", "library", ["compile", "check"]],
        ["tsconfig.test.json", "test_tsconfig", ["test_tsc"]],
      ]);
    }));

  test.for([
    { name: "declares an empty file list", config: '{"files": []}', rules: [] },
    {
      name: "has kept empty sources",
      config: '{"include": ["src/**/*.ts"]}',
      rules: [
        rule(
          "js_tsconfig",
          "shared_tsconfig",
          { config: "tsconfig.shared.json", srcs: strings([]) },
          ["srcs"],
        ),
      ],
    },
  ])("a config that $name only provides options", ({ config, rules }) =>
    run(function* () {
      const fixture = yield* useFixture({ "lib/tsconfig.shared.json": config });
      const project = discoverProjects(fixture.pkg("lib", rules), []).find(
        (item) => item.local === "tsconfig.shared.json",
      );
      expect(project).toMatchObject({ entry: false, compilations: [] });
    }),
  );

  test("an existing rule for an extended config keeps it options-only unless compiled", () =>
    run(function* () {
      const fixture = yield* useFixture({
        "lib/configs/shared.json": '{"compilerOptions": {"strict": true}}',
        "lib/tsconfig.check.json":
          '{"extends": "./configs/shared.json", "include": ["src/**/*.ts"]}',
      });
      const provider = rule("js_tsconfig", "shared_tsconfig", { config: "configs/shared.json" });
      const shared = (rules: (typeof provider)[]) =>
        discoverProjects(fixture.pkg("lib", rules), []).find(
          (item) => item.name === "shared_tsconfig",
        );
      expect(shared([provider])).toMatchObject({ entry: false, compilations: [] });
      const compiled = rule("js_tsc", "shared_tsc", { config: ":shared_tsconfig" });
      expect(shared([provider, compiled])).toMatchObject({
        entry: true,
        compilations: ["shared_tsc"],
      });
    }));

  test("typecheck configs outside the package root are entries", () =>
    run(function* () {
      const fixture = yield* useFixture({
        "lib/configs/typecheck.json": '{"extends": "../tsconfig.test.json"}',
      });
      const project = discoverProjects(fixture.pkg("lib"), ["configs/typecheck.json"]).find(
        (item) => item.local === "configs/typecheck.json",
      );
      expect(project).toMatchObject({
        name: "typecheck_tsconfig",
        entry: true,
        compilations: ["typecheck_tsc"],
      });
    }));

  test("two configs deriving one name are an input error", () =>
    run(function* () {
      const fixture = yield* useFixture({ "lib/configs/tsconfig.lib.json": "{}" });
      const pkg = fixture.pkg("lib", [
        rule("js_tsconfig", "configs_tsconfig", { config: "configs/tsconfig.lib.json" }),
        rule("js_tsconfig", "lib_tsconfig", { config: "configs/tsconfig.lib.json" }),
      ]);
      let failure: unknown;
      try {
        discoverProjects(pkg, []);
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(ConnectError);
      expect(failure).toMatchObject({ code: Code.InvalidArgument });
    }));

  test.for([
    ["tsconfig.json", ""],
    ["tsconfig.lib.json", "lib"],
    ["tsconfig.base.json", "base"],
    ["tsconfig.check-types.json", "check_types"],
    ["node_modules/$app/tsconfig.json", "kit"],
    [".svelte-check/tsconfig.json", "svelte_check"],
    ["configs/lib.json", "lib"],
  ] as const)("%s has role %j", ([local, role]) =>
    run(function* () {
      yield* call(() => {
        expect(projectRole(local)).toBe(role);
      });
    }),
  );
});

// The compiler options of a fixture library config.
function* options(files: Record<string, string>, local: string) {
  const fixture = yield* useFixture(files);
  const pkg = fixture.pkg("lib", [
    rule("js_tsconfig", "nested_tsconfig", { config: "configs/tsconfig.json" }),
  ]);
  const project = discoverProjects(pkg, []).find((item) => item.local === local)!;
  return Object.fromEntries(compilerOptions(project, pkg));
}

describe("compilerOptions", () => {
  test("a config declares what it contributes over what its bases' rules provide", () =>
    run(function* () {
      // The root base provides declaration and sourceMap, and TypeScript's
      // default resolveJsonModule needs no declaration.
      expect(yield* options({}, "tsconfig.lib.json")).toEqual({ outDir: "dist", rootDir: "src" });
      expect(yield* options({}, "tsconfig.test.json")).toEqual({ noEmit: true, rootDir: "." });
      // The provider moves inherited paths; nothing is left to declare.
      expect(
        yield* options(
          { "lib/configs/tsconfig.json": '{"extends": "../tsconfig.lib.json", "include": []}' },
          "configs/tsconfig.json",
        ),
      ).toEqual({});
    }));

  test("the difference is taken against what the rules provide, not re-derived options", () =>
    run(function* () {
      const files = {
        "lib/configs/node10.json": JSON.stringify({
          compilerOptions: { moduleResolution: "node10", ignoreDeprecations: "6.0" },
        }),
        "lib/configs/bundler.json": JSON.stringify({
          compilerOptions: { moduleResolution: "bundler" },
        }),
        "lib/tsconfig.mixed.json": JSON.stringify({
          extends: ["./configs/node10.json", "./configs/bundler.json"],
          include: ["src/**/*.ts"],
        }),
      };
      // node10 derives resolveJsonModule false, so its rule records it; bundler
      // derives TypeScript's default and records nothing.
      expect(yield* options(files, "configs/node10.json")).toEqual({ resolveJsonModule: false });
      expect(yield* options(files, "configs/bundler.json")).toEqual({});
      // TypeScript derives true for the merge, and the rules would pass on
      // false, so the extender declares true.
      expect(yield* options(files, "tsconfig.mixed.json")).toEqual({ resolveJsonModule: true });
    }));

  test("explicit false overrides and null resets replace inherited values", () =>
    run(function* () {
      expect(
        yield* options(
          {
            "lib/tsconfig.check.json":
              '{"extends": "./tsconfig.lib.json", "compilerOptions": {"declaration": false, "sourceMap": null, "rootDir": null, "jsx": "react-jsx"}}',
          },
          "tsconfig.check.json",
        ),
      ).toEqual({ declaration: false, jsx: "react-jsx", rootDir: null, sourceMap: null });
      // The editor project repeats noEmit and resets rootDir.
      expect(yield* options({}, "tsconfig.json")).toEqual({ rootDir: null });
    }));
});

describe("projects", () => {
  test("patterns are relative to the package, and none selects SvelteKit's generated files", () =>
    run(function* () {
      const fixture = yield* useFixture();
      const pkg = fixture.pkg("app");
      const projects = discoverProjects(pkg, []);
      const kit = projects.find((item) => item.name === "kit")!;
      expect(projectPatterns(kit, pkg)).toMatchObject({ include: ["src/**/*.ts"], exclude: [] });
      const app = projects.find((item) => item.name === "tsconfig")!;
      expect(projectPatterns(app, pkg).include).toEqual([
        "src/**/*.ts",
        "src/**/*.svelte",
        "vite.config.ts",
      ]);
    }));

  test("outputs map to their sources", () =>
    run(function* () {
      const fixture = yield* useFixture();
      const pkg = fixture.pkg("lib");
      const projects = discoverProjects(pkg, []);
      const outputs = projectOutputs(
        projects.find((item) => item.name === "lib_tsconfig")!,
        pkg,
      );
      expect(outputs.get("lib/dist/index.js")).toEqual({
        project: "lib_tsconfig",
        source: "lib/src/index.ts",
      });
      expect(outputs.get("lib/dist/value.d.ts")).toEqual({
        project: "lib_tsconfig",
        source: "lib/src/value.ts",
      });
      expect(
        projectOutputs(
          projects.find((item) => item.name === "tsconfig")!,
          pkg,
        ).size,
      ).toBe(0);
    }));

  test("a config that is not valid JSON is an input error naming the file", () =>
    run(function* () {
      const fixture = yield* useFixture({
        "lib/tsconfig.json": '{"extends": "./tsconfig.test.json",',
      });
      let failure: unknown;
      try {
        discoverProjects(fixture.pkg("lib"), []);
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({
        code: Code.InvalidArgument,
        rawMessage: "lib/tsconfig.json: '}' expected.",
      });
    }));

  test("TypeScript configuration errors name the file", () =>
    run(function* () {
      const fixture = yield* useFixture({
        "lib/tsconfig.json": '{"references": [{"path": "../app"}]}',
      });
      let failure: unknown;
      try {
        discoverProjects(fixture.pkg("lib"), []);
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({
        code: Code.InvalidArgument,
        rawMessage:
          "lib/tsconfig.json: project references are unsupported; import other packages through their pnpm dependencies",
      });
    }));
});
