import fs from "node:fs";
import { Code, ConnectError } from "@connectrpc/connect";
import { run } from "effection";
import { describe, expect, test } from "vitest";

import { rule, rules, useFixture } from "../tests/support/fixture.js";
import type { Check } from "./checks.js";
import { checkTests } from "./checks.js";

function check(value: string) {
  return { name: "js_check", value };
}

// Every check kind, as the repository root enables them.
const enabled = [
  check("js_oxlint_test //:.oxlintrc.json"),
  check("js_oxfmt_test //:.oxfmtrc.json"),
  check("js_prettier_test //:.prettierrc.json @pnpm//node_modules/prettier-plugin-svelte"),
  check("js_knip_test //:.gitignore //:pnpm-workspace.yaml"),
];

// The configuration rules generation produces for the fixture's application.
// No check depends on :kit: the tsconfigs extending it carry what it generates.
const configurations = [
  { kind: "js_vite", name: "vite_build" },
  { kind: "js_vite_config", name: "vite_config" },
  { kind: "js_storybook", name: "storybook" },
  { kind: "js_vite_config", name: "storybook_vite_config" },
  { kind: "js_tsc", name: "tsc" },
  { kind: "js_tsconfig", name: "tsconfig" },
  { kind: "js_svelte_kit", name: "kit" },
  { kind: "js_vite_config", name: "vitest_config" },
];

function generated(checks: Check[]) {
  return rules(
    checks.map((item) => ({ ...item, attributes: Object.fromEntries(item.attributes) })),
  );
}

function failure(operation: () => unknown): unknown {
  try {
    operation();
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to fail");
}

describe("checkTests", () => {
  test("the last js_check directive of a kind decides its data, and off disables it", () =>
    run(function* () {
      const fixture = yield* useFixture();
      const checks = checkTests(
        fixture.pkg("lib"),
        [
          check("js_oxlint_test //:.oxlintrc.json"),
          check("js_oxfmt_test //:.oxfmtrc.json"),
          check("js_oxlint_test  //:tsconfig.base.json\t//:.oxlintrc.json "),
          check("js_oxfmt_test off"),
        ],
        [],
      );
      expect(checks.map((item) => item.name)).toEqual(["oxlint_test"]);
      expect(generated(checks)["oxlint_test"]).toMatchObject({
        data: ["//:.oxlintrc.json", "//:tsconfig.base.json"],
      });
      // A subtree turns a kind back on without data.
      const again = checkTests(
        fixture.pkg("lib"),
        [
          check("js_oxfmt_test //:.oxfmtrc.json"),
          check("js_oxfmt_test off"),
          check("js_oxfmt_test"),
        ],
        [],
      );
      expect(generated(again)).toEqual({
        oxfmt_test: {
          kind: "js_oxfmt_test",
          srcs: { glob: ["*.json", "*.ts", "src/**/*.ts"], exclude: [], allowEmpty: false },
          data: [],
          deps: [],
        },
      });
    }));

  test.for([
    [
      "js_eslint_test //:.eslintrc.json",
      'gazelle:js_check js_eslint_test //:.eslintrc.json: "js_eslint_test" is not a check test kind; use one of js_oxlint_test, js_oxfmt_test, js_prettier_test, js_knip_test',
    ],
    [
      "js_oxlint_test :.oxlintrc.json",
      'gazelle:js_check js_oxlint_test :.oxlintrc.json: :.oxlintrc.json is not an absolute label; name data as //package:target or @repository//package:target, or write "js_oxlint_test off" alone',
    ],
    [
      "js_oxlint_test off //:.oxlintrc.json",
      'gazelle:js_check js_oxlint_test off //:.oxlintrc.json: off is not an absolute label; name data as //package:target or @repository//package:target, or write "js_oxlint_test off" alone',
    ],
  ] as const)("rejects the directive %s", ([value, message]) =>
    run(function* () {
      const fixture = yield* useFixture();
      const error = failure(() => checkTests(fixture.pkg("lib"), [check(value)], []));
      expect(error).toBeInstanceOf(ConnectError);
      expect(error).toMatchObject({ code: Code.InvalidArgument, rawMessage: message });
    }),
  );

  test("only workspace members other than the repository root get check tests", () =>
    run(function* () {
      const fixture = yield* useFixture({ "knip.json": "{}\n", "app/generated/knip.json": "{}\n" });
      expect(checkTests(fixture.pkg(""), enabled, [])).toEqual([]);
      expect(checkTests(fixture.pkg("app/generated"), enabled, [])).toEqual([]);
      expect(checkTests(fixture.pkg("lib"), enabled, []).map((item) => item.name)).toEqual([
        "oxlint_test",
        "oxfmt_test",
      ]);
    }));

  test("Prettier checks Svelte components outside hidden directories, created with their directories", () =>
    run(function* () {
      const fixture = yield* useFixture({
        "app/App.svelte": "<p>app</p>\n",
        "app/.svelte-kit/generated/root.svelte": "<slot />\n",
        "lib/.storybook/Decorator.svelte": "<slot />\n",
      });
      const app = generated(checkTests(fixture.pkg("app"), enabled, configurations));
      expect(app["prettier_test"]).toEqual({
        kind: "js_prettier_test",
        srcs: { glob: ["*.svelte", "src/**/*.svelte"], exclude: [], allowEmpty: false },
        data: ["//:.prettierrc.json", "@pnpm//node_modules/prettier-plugin-svelte"],
        deps: [],
        paths: ["*.svelte", "src/**/*.svelte"],
      });
      // Only stories use Svelte in the library.
      expect(checkTests(fixture.pkg("lib"), enabled, []).map((item) => item.name)).not.toContain(
        "prettier_test",
      );
    }));

  test("Knip runs a default and a production test in members with a knip.json", () =>
    run(function* () {
      const fixture = yield* useFixture({
        "app/knip.json": "{}\n",
        "lib/knip.json": "{}\n",
        "lib/package.json": '{ "private": true }\n',
      });
      const app = generated(checkTests(fixture.pkg("app"), enabled, configurations));
      expect(app["knip_test"]).toMatchObject({
        kind: "js_knip_test",
        data: ["//:.gitignore", "//:pnpm-workspace.yaml"],
        workspace: "@fixture/app",
      });
      expect(app["knip_test"]).not.toHaveProperty("production");
      expect(app["knip_production_test"]).toEqual({ ...app["knip_test"], production: true });
      expect(app["knip_test"]!["srcs"]).toEqual({
        glob: [
          "*.json",
          "*.ts",
          ".storybook/**/*.ts",
          "src/**/*.svelte",
          "src/**/*.ts",
          "src/lib/**",
        ],
        exclude: [],
        allowEmpty: false,
      });
      // An unnamed member is Knip's current workspace.
      const lib = generated(checkTests(fixture.pkg("lib"), enabled, []));
      expect(lib["knip_test"]).toMatchObject({ workspace: "." });
      fixture.remove("lib/knip.json");
      expect(checkTests(fixture.pkg("lib"), enabled, []).map((item) => item.name)).toEqual([
        "oxlint_test",
        "oxfmt_test",
      ]);
    }));

  test("Knip stages the configurations and the packages the member's own manifest declares", () =>
    run(function* () {
      const fixture = yield* useFixture({
        "app/knip.json": "{}\n",
        // The member's bindings also hold @types/node, vitest and
        // @storybook/svelte-vite, as the root's devDependencies would be;
        // typescript has no binding.
        "app/package.json": JSON.stringify({
          name: "@fixture/app",
          dependencies: { "@fixture/lib": "workspace:*", svelte: "^5.0.0" },
          devDependencies: { "@sveltejs/kit": "^2.0.0", typescript: "^6.0.0" },
          peerDependencies: { vite: "^8.0.0" },
          optionalDependencies: { fsevents: "^2.0.0" },
        }),
      });
      // This case proves absent bindings remain absent even when tools exist elsewhere.
      const index = JSON.parse(fs.readFileSync(fixture.index, "utf8"));
      delete index.packages.app.bindings.typescript;
      fs.writeFileSync(fixture.index, JSON.stringify(index));
      const app = generated(checkTests(fixture.pkg("app"), enabled, configurations));
      expect(app["knip_test"]!["deps"]).toEqual({
        concatenation: [
          [
            ":storybook_vite_config",
            ":tsconfig",
            ":vite_config",
            ":vitest_config",
            "//lib",
            "@pnpm//node_modules/@sveltejs/kit",
            "@pnpm//node_modules/svelte",
            "@pnpm//node_modules/vite",
          ],
          {
            select: {
              "//gazelle/platforms:darwin_arm64": ["@pnpm//node_modules/fsevents"],
              "//conditions:default": [],
            },
          },
        ],
      });
      // Oxlint's tsconfigs already carry their packages.
      expect(app["oxlint_test"]!["deps"]).toEqual([":tsconfig"]);
      expect(app["oxfmt_test"]!["deps"]).toEqual([]);
    }));

  test("Knip stages the files the member's imports map resolves to, whatever their type", () =>
    run(function* () {
      const fixture = yield* useFixture({
        "app/knip.json": "{}\n",
        "app/package.json": JSON.stringify({
          name: "@fixture/app",
          imports: {
            "#fixtures/*": "./tests/fixtures/*",
            "#internal/*": { svelte: "./src/lib/*.svelte", default: "./src/lib/*.ts" },
            "#config": "./app.config.slop",
            "#outside/*": "../lib/*",
          },
        }),
        "app/tests/fixtures/scene.slop": "scene\n",
        "app/app.config.slop": "config\n",
      });
      const app = generated(checkTests(fixture.pkg("app"), enabled, configurations));
      expect(app["knip_test"]!["srcs"]).toMatchObject({
        concatenation: [
          ["app.config.slop"],
          { glob: expect.arrayContaining(["src/lib/**", "tests/fixtures/**"]) },
        ],
      });
      expect(JSON.stringify(app["knip_test"]!["srcs"])).not.toContain("../");
      expect(app["knip_production_test"]!["srcs"]).toEqual(app["knip_test"]!["srcs"]);
      // Only Knip resolves the specifiers.
      expect((app["oxlint_test"]!["srcs"] as { glob: string[] }).glob).not.toContain(
        "tests/fixtures/**",
      );
    }));

  test("srcs are globs per top-level directory and extension, whatever git ignores", () =>
    run(function* () {
      const fixture = yield* useFixture({ "app/knip.json": "{}\n" });
      const srcs = () =>
        Object.fromEntries(
          checkTests(fixture.pkg("app"), enabled, configurations).map((item) => [
            item.name,
            generated([item])[item.name]!["srcs"],
          ]),
        );
      const clean = srcs();
      expect(clean["oxlint_test"]).toEqual({
        glob: ["*.ts", ".storybook/**/*.ts", "src/**/*.svelte", "src/**/*.ts", "tsconfig*.json"],
        exclude: [],
        allowEmpty: false,
      });
      expect(clean["oxfmt_test"]).toEqual({
        glob: ["*.json", "*.ts", ".storybook/**/*.ts", "src/**/*.ts"],
        exclude: [],
        allowEmpty: false,
      });
      // A generated file only some checkouts have is matched by extension, and
      // SvelteKit's output is never a source directory.
      fixture.write("app/tauri.generated.conf.json", "{}\n");
      fixture.write("app/.svelte-kit/types/route.d.ts", "export {};\n");
      expect(srcs()).toEqual(clean);
      fixture.remove("app/.svelte-kit");
      expect(srcs()).toEqual(clean);
    }));

  test("srcs follow the operands of authored paths", () =>
    run(function* () {
      const fixture = yield* useFixture();
      const existing = [
        rule("js_oxlint_test", "oxlint_test", { paths: ["src/lib", "vite.config.ts"] }),
        rule("js_oxfmt_test", "oxfmt_test", { paths: ["./"] }),
        rule("js_prettier_test", "prettier_test", {
          paths: ["src/routes/**/*.svelte", "missing/**/*.svelte", "**/*.svelte"],
        }),
      ];
      const checks = checkTests(fixture.pkg("app", existing), enabled, configurations);
      expect(checks.flatMap((item) => item.problems)).toEqual([]);
      const app = generated(checks);
      expect(app["oxlint_test"]!["srcs"]).toEqual({
        concatenation: [
          ["vite.config.ts"],
          {
            glob: ["src/lib/**/*.svelte", "src/lib/**/*.ts"],
            exclude: [],
            allowEmpty: false,
          },
        ],
      });
      expect(app["oxfmt_test"]!["srcs"]).toEqual({
        glob: ["*.json", "*.ts", ".storybook/**/*.ts", "src/**/*.ts"],
        exclude: [],
        allowEmpty: false,
      });
      // Globs stay as written; Bazel ignores SvelteKit's output, so none
      // excludes it.
      expect(app["prettier_test"]).toEqual({
        kind: "js_prettier_test",
        srcs: {
          glob: ["**/*.svelte", "missing/**/*.svelte", "src/routes/**/*.svelte"],
          exclude: [],
          allowEmpty: true,
        },
        data: ["//:.prettierrc.json", "@pnpm//node_modules/prettier-plugin-svelte"],
        deps: [],
      });
    }));

  test("operands srcs cannot follow are problems", () =>
    run(function* () {
      const fixture = yield* useFixture({ "app/src/routes/[slug]/+page.svelte": "<p />\n" });
      const existing = [
        rule("js_oxlint_test", "oxlint_test", {
          paths: ["src/{lib,routes}", "../lib", "missing", "src/routes/[slug]"],
        }),
        rule("js_oxfmt_test", "oxfmt_test", { paths: "." }),
      ];
      const checks = checkTests(fixture.pkg("app", existing), enabled, configurations);
      expect(checks.find((item) => item.name === "oxlint_test")!.problems).toEqual([
        '//app:oxlint_test: paths names src/{lib,routes}, which is neither ".", a directory or file of the package nor a glob of literal segments, * and **',
        '//app:oxlint_test: paths names ../lib, which is neither ".", a directory or file of the package nor a glob of literal segments, * and **',
        '//app:oxlint_test: paths names missing, which is neither ".", a directory or file of the package nor a glob of literal segments, * and **',
        "//app:oxlint_test: no glob of literal segments, * and ** can name src/routes/[slug]",
      ]);
      expect(checks.find((item) => item.name === "oxfmt_test")!.problems).toEqual([
        "//app:oxfmt_test: paths must be a list of strings",
      ]);
    }));

  test("explicit files stand alone and are not repeated beside matching globs", () =>
    run(function* () {
      const fixture = yield* useFixture();
      for (const [paths, srcs] of [
        [["vite.config.ts"], ["vite.config.ts"]],
        [["vite.config.ts", "*.ts"], { glob: ["*.ts"], exclude: [], allowEmpty: false }],
        [
          ["vite.config.ts", "missing/**/*.ts"],
          {
            concatenation: [
              ["vite.config.ts"],
              { glob: ["missing/**/*.ts"], exclude: [], allowEmpty: true },
            ],
          },
        ],
      ] as const) {
        const existing = [rule("js_oxlint_test", "oxlint_test", { paths: [...paths] })];
        const checks = checkTests(fixture.pkg("app", existing), enabled, configurations);
        expect(checks.flatMap((item) => item.problems)).toEqual([]);
        expect(generated(checks)["oxlint_test"]!["srcs"]).toEqual(srcs);
      }
    }));

  test("excluded literal imports stay outside Knip's declared inputs", () =>
    run(function* () {
      const fixture = yield* useFixture({
        "app/knip.json": "{}\n",
        "app/package.json": JSON.stringify({
          name: "@fixture/app",
          imports: { "#config": "./app.config.ts", "#missing": "./missing.config.slop" },
        }),
        "app/app.config.ts": "export {};\n",
      });
      const app = generated(
        checkTests(fixture.pkg("app", [], ["app.config.ts"]), enabled, configurations),
      );
      expect(app["knip_test"]!["srcs"]).toMatchObject({
        glob: expect.any(Array),
        exclude: ["app.config.ts"],
      });
      expect(JSON.stringify(app["knip_test"]!["srcs"])).not.toContain("missing.config.slop");
    }));

  test("paths Gazelle excludes stay out of the globs", () =>
    run(function* () {
      const fixture = yield* useFixture({
        "lib/src/generated/schema.ts": "export {};\n",
        "lib/src/skipped.ts": "export {};\n",
      });
      const pkg = fixture.pkg("lib", [], ["src/generated", "src/skipped.ts"]);
      expect(generated(checkTests(pkg, enabled, []))["oxlint_test"]!["srcs"]).toEqual({
        glob: ["*.ts", "src/**/*.ts", "tsconfig*.json"],
        exclude: ["src/generated/**", "src/skipped.ts"],
        allowEmpty: false,
      });
    }));
});
