import { loads } from "../tests/support/fixture.js";
import fs from "node:fs";

import { create } from "@bufbuild/protobuf";
import type { Client } from "@connectrpc/connect";
import {
  Code,
  ConnectError,
  createClient,
  createHandlerContext,
  createRouterTransport,
} from "@connectrpc/connect";
import { call, run } from "effection";
import type { Operation } from "effection";
import { describe, expect, test } from "vitest";

import type { Fixture } from "../tests/support/fixture.js";
import { inventory, rule, rules, useFixture } from "../tests/support/fixture.js";
import {
  GenerateRequestSchema,
  LanguageService,
  ValueSchema,
} from "./generated/gazelle/v1/language_pb.js";
import type { GenerateResponse, Rule } from "./generated/gazelle/v1/language_pb.js";
import { createService } from "./service.js";
import { concatenation, glob, strings, scalar } from "./values.js";

const visibility = ["//:__subpackages__", "@pnpm//:__subpackages__"];

function* useClient(fixture: Fixture): Operation<Client<typeof LanguageService>> {
  const client = createClient(
    LanguageService,
    createRouterTransport((router) =>
      router.service(LanguageService, createService({ index: fixture.index, loads })),
    ),
  );
  yield* call(() => client.initialize({ repositoryRoot: fixture.root }));
  return client;
}

// Directives in effect are listed outermost first, like the host's.
function request(
  fixture: Fixture,
  pkg: string,
  existing: Rule[] = [],
  directives: readonly (readonly [string, string])[] = [],
) {
  const { files, excluded } = inventory(fixture.root, pkg);
  return create(GenerateRequestSchema, {
    package: pkg,
    files: [...files],
    excludedPaths: [...excluded],
    directives: directives.map(([name, value]) => ({ name, value })),
    buildFile: { name: "BUILD.bazel", rules: existing },
  });
}

// A Vitest rule naming a source that does not exist.
function missingSources(kept: string[]) {
  return rule(
    "js_vitest",
    "unit_test",
    { config: ":vitest_config", srcs: ["missing.test.ts"], deps: ["//manual:fixture"] },
    kept,
  );
}

// An Oxfmt test whose paths name a brace glob, which srcs cannot follow.
function bracedPaths(kept: string[]) {
  return rule("js_oxfmt_test", "oxfmt_test", { paths: ["src/{a,b}"], srcs: ["src/a.ts"] }, kept);
}

// The existing rules after the host applies a response: stale rules removed,
// generated attributes merged into matching rules and new rules appended.
function applied(existing: Rule[], response: GenerateResponse): Rule[] {
  const stale = new Set(response.staleRules.map(({ kind, name }) => `${kind}:${name}`));
  const result = existing
    .filter(({ kind, name }) => !stale.has(`${kind}:${name}`))
    .map((current) => {
      const update = response.rules.find(
        ({ kind, name }) => kind === current.kind && name === current.name,
      );
      const attributes = Object.fromEntries(
        Object.entries(current.attributes).flatMap(([key, attribute]) =>
          attribute.value ? [[key, attribute.value]] : [],
        ),
      );
      return update
        ? rule(current.kind, current.name, { ...attributes, ...update.attributes })
        : current;
    });
  for (const update of response.rules) {
    if (!result.some(({ kind, name }) => kind === update.kind && name === update.name)) {
      result.push(rule(update.kind, update.name, update.attributes));
    }
  }
  return result;
}

function* failure(operation: () => Promise<unknown>): Operation<unknown> {
  try {
    yield* call(operation);
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to fail");
}

describe("Initialize", () => {
  test("describes kinds, loads, directives and packages", () =>
    run(function* () {
      const fixture = yield* useFixture();
      const client = createClient(
        LanguageService,
        createRouterTransport((router) =>
          router.service(LanguageService, createService({ index: fixture.index, loads })),
        ),
      );
      const response = yield* call(() => client.initialize({ repositoryRoot: fixture.root }));
      expect(response.packages).toEqual(["", "app", "lib"]);
      expect(response.loads.map(({ label, symbols }) => ({ label, symbols }))).toEqual([
        {
          label: "//rules:defs.bzl",
          symbols: [
            "js_knip_test",
            "js_oxfmt_test",
            "js_oxlint_test",
            "js_prettier_test",
            "js_storybook",
            "js_svelte_kit",
            "js_tsc",
            "js_tsconfig",
            "js_vite",
            "js_vite_config",
            "js_vitest",
          ],
        },
      ]);
      expect(response.directives.map(({ name, inherited }) => [name, inherited])).toEqual([
        ["js_check", true],
        ["js_package", false],
        ["js_typescript", true],
      ]);
      const kinds = Object.fromEntries(
        response.kinds.map((kind) => [
          kind.name,
          [kind.mergeableAttributes, kind.resolveAttributes],
        ]),
      );
      expect(kinds).toEqual({
        js_storybook: [
          ["config_dir", "srcs"],
          ["aliases", "deps"],
        ],
        js_svelte_kit: [["compiler_options", "config", "deps", "srcs", "tool_deps"], []],
        js_tsc: [["config", "typescript"], []],
        js_tsconfig: [
          ["compiler_options", "config", "srcs"],
          ["aliases", "data", "deps", "extends"],
        ],
        js_vite: [["config"], []],
        js_vite_config: [["config"], ["aliases", "deps"]],
        js_vitest: [["config"], ["aliases", "deps"]],
        js_oxlint_test: [["data", "deps", "srcs"], []],
        js_oxfmt_test: [["data", "deps", "srcs"], []],
        js_prettier_test: [["data", "deps", "srcs"], []],
        js_knip_test: [["data", "deps", "production", "srcs", "workspace"], []],
      });
      for (const kind of response.kinds) {
        const owned = [...kind.mergeableAttributes, ...kind.resolveAttributes];
        expect(new Set(owned).size).toBe(owned.length);
        expect(kind.nonEmptyAttributes.every((name) => owned.includes(name))).toBe(true);
      }
    }));

  test("generation needs initialization", () =>
    run(function* () {
      const fixture = yield* useFixture();
      const client = createClient(
        LanguageService,
        createRouterTransport((router) =>
          router.service(LanguageService, createService({ index: fixture.index, loads })),
        ),
      );
      const error = yield* failure(() => client.generate(request(fixture, "lib")));
      expect(error).toMatchObject({ code: Code.Internal });
    }));
});

describe("Generate", () => {
  test("a library's projects in reading order from its package target", () =>
    run(function* () {
      const fixture = yield* useFixture();
      const client = yield* useClient(fixture);
      const response = yield* call(() =>
        client.generate(
          request(fixture, "lib", [rule("js_package", "lib", { srcs: [":lib_tsc"] })]),
        ),
      );
      expect(response.rules.map((item) => item.name)).toEqual([
        "lib_tsc",
        "lib_tsconfig",
        "tsc",
        "tsconfig",
        // tsconfig.json extends tsconfig.test.json.
        "test_tsconfig",
        "test_tsc",
        "vitest_config",
      ]);
      const generated = rules(response.rules);
      expect(generated["lib_tsc"]).toEqual({
        kind: "js_tsc",
        config: ":lib_tsconfig",
        tsc: "@pnpm//node_modules/@typescript/native:tsc",
        typescript: "@pnpm//node_modules/typescript",
        visibility,
      });
      expect(generated["lib_tsconfig"]).toEqual({
        kind: "js_tsconfig",
        config: "tsconfig.lib.json",
        // Only what tsconfig.lib.json contributes over the root base's rule.
        compiler_options: { outDir: "dist", rootDir: "src" },
        srcs: { glob: ["src/**/*.ts"], exclude: ["src/**/*.test.ts"], allowEmpty: false },
        // Another package's config is inherited from the rule providing it, or
        // else as its file.
        extends: [{ reference: "file:tsconfig.base.json", fallback: "//:tsconfig.base.json" }],
        deps: ["@pnpm//node_modules/@types/node"],
        aliases: {},
        visibility,
      });
      expect(generated["tsconfig"]).toMatchObject({
        compiler_options: { rootDir: null },
        // Only the configuration it names: that one passes on the rest.
        extends: [":test_tsconfig"],
        srcs: {
          concatenation: [
            ["vitest.config.ts"],
            { glob: ["src/**/*.ts"], exclude: [], allowEmpty: false },
          ],
        },
        deps: ["@pnpm//node_modules/@types/node", "@pnpm//node_modules/vitest"],
      });
      expect(response.staleRules).toEqual([]);
    }));

  test("created projects with test inputs and test configs are testonly", () =>
    run(function* () {
      const fixture = yield* useFixture();
      const client = yield* useClient(fixture);
      const testonly = (existing: Rule[]) =>
        call(function* () {
          const response = yield* call(() => client.generate(request(fixture, "lib", existing)));
          return Object.fromEntries(
            Object.entries(rules(response.rules)).map(([name, item]) => [
              name,
              item["testonly"] ?? false,
            ]),
          );
        });
      expect(yield* testonly([])).toEqual({
        lib_tsc: false,
        lib_tsconfig: false,
        tsc: true,
        tsconfig: true,
        test_tsc: true,
        test_tsconfig: true,
        vitest_config: true,
      });
      // The package default already applies.
      const inherited = rule("package", "", { default_testonly: true });
      expect(Object.values(yield* testonly([inherited])).some(Boolean)).toBe(false);
      // Existing rules keep what they declare.
      const authored = [rule("js_tsconfig", "tsconfig", { config: "tsconfig.json" })];
      expect(yield* testonly(authored)).toMatchObject({ tsconfig: false, tsc: false });
    }));

  test("the root base config only provides options", () =>
    run(function* () {
      const fixture = yield* useFixture();
      const client = yield* useClient(fixture);
      const response = yield* call(() =>
        client.generate(
          request(fixture, "", [
            rule(
              "js_tsconfig",
              "base_tsconfig",
              { config: "tsconfig.base.json", srcs: strings([]) },
              ["srcs"],
            ),
          ]),
        ),
      );
      expect(rules(response.rules)).toEqual({
        base_tsconfig: {
          kind: "js_tsconfig",
          config: "tsconfig.base.json",
          compiler_options: { declaration: true, sourceMap: true },
          extends: [],
          deps: [],
        },
      });
    }));

  test("an application's configurations, consumers and Storybook", () =>
    run(function* () {
      const fixture = yield* useFixture();
      const client = yield* useClient(fixture);
      const response = yield* call(() => client.generate(request(fixture, "app")));
      expect(response.rules.map((item) => `${item.kind}:${item.name}`)).toEqual([
        "js_vite:vite_build",
        "js_vite_config:vite_config",
        "js_storybook:storybook",
        "js_vite_config:storybook_vite_config",
        "js_tsc:tsc",
        "js_tsconfig:tsconfig",
        // tsconfig.json extends SvelteKit's generated configuration, which
        // js_svelte_kit generates and provides.
        "js_svelte_kit:kit",
        "js_vite_config:vitest_config",
      ]);
      const generated = rules(response.rules);
      expect(generated["vite_build"]).toEqual({
        kind: "js_vite",
        vite: "@pnpm//node_modules/vite:bin",
        config: ":vite_config",
        visibility,
      });
      expect(generated["vite_config"]).toMatchObject({
        config: "vite.config.ts",
        deps: ["@pnpm//node_modules/@sveltejs/adapter-static", "@pnpm//node_modules/@sveltejs/kit"],
      });
      expect(generated["vitest_config"]).toMatchObject({
        deps: [":vite_config", "@pnpm//node_modules/vitest"],
        testonly: true,
      });
      expect(generated["storybook_vite_config"]).toMatchObject({ testonly: true });
      expect(generated["vite_config"]).not.toHaveProperty("testonly");
      expect(generated["tsconfig"]).toMatchObject({ testonly: true });
      expect(generated["tsc"]).toMatchObject({ testonly: true });
      expect(generated["storybook"]).toEqual({
        kind: "js_storybook",
        storybook: "@pnpm//node_modules/storybook:bin",
        testonly: true,
        config_dir: ".storybook",
        srcs: [".storybook/main.ts"],
        deps: [":storybook_vite_config", "@pnpm//node_modules/@storybook/svelte-vite"],
        aliases: {},
      });
      // The same inputs whatever the checkout holds, without dotfiles.
      expect(generated["kit"]).toEqual({
        kind: "js_svelte_kit",
        kit: "@pnpm//node_modules/@sveltejs/kit:bin",
        typescript: "@pnpm//node_modules/typescript",
        srcs: {
          glob: ["src/*", "src/lib/**", "src/routes/**", "static/**"],
          exclude: ["**/.*"],
          allowEmpty: true,
        },
        tool_deps: [
          "@pnpm//node_modules/@sveltejs/adapter-static",
          "@pnpm//node_modules/@sveltejs/kit",
        ],
        deps: ["@pnpm//node_modules/@sveltejs/kit", "@pnpm//node_modules/svelte"],
        compiler_options: { noEmit: true },
        visibility,
      });
      // Nothing under .svelte-kit is listed: the project inherits it from :kit.
      expect(generated["tsconfig"]).toMatchObject({
        // In tsconfig.json's order, since later bases override earlier ones.
        extends: [
          { reference: "file:tsconfig.base.json", fallback: "//:tsconfig.base.json" },
          ":kit",
        ],
        srcs: {
          concatenation: [
            ["vite.config.ts"],
            {
              glob: ["src/**/*.svelte", "src/**/*.ts"],
              exclude: [],
              allowEmpty: false,
            },
          ],
        },
        deps: [
          "//lib",
          "@pnpm//node_modules/@sveltejs/adapter-static",
          "@pnpm//node_modules/@sveltejs/kit",
          "@pnpm//node_modules/@types/node",
          "@pnpm//node_modules/vite",
          "@pnpm//node_modules/vitest",
          { reference: "file:app/generated/api.ts", fallback: "//app/generated:api.ts" },
        ],
      });
    }));

  test("SvelteKit stages imported root declarations once", () =>
    run(function* () {
      const fixture = yield* useFixture({
        "app/src/env.ts":
          'import { defineEnvVars } from "@sveltejs/kit/env"; export default defineEnvVars({});\n',
      });
      const client = yield* useClient(fixture);
      const response = yield* call(() => client.generate(request(fixture, "app")));
      expect(rules(response.rules)["kit"]).toMatchObject({
        srcs: {
          concatenation: [
            ["src/env.ts"],
            {
              glob: ["src/*", "src/lib/**", "src/routes/**", "static/**"],
              exclude: ["**/.*", "src/env.ts"],
              allowEmpty: true,
            },
          ],
        },
        tool_deps: [
          "@pnpm//node_modules/@sveltejs/adapter-static",
          "@pnpm//node_modules/@sveltejs/kit",
        ],
      });
    }));

  test("SvelteKit uses the declared Vite configuration and supports alternate extensions", () =>
    run(function* () {
      const fixture = yield* useFixture({ "app/vite.config.mts": "export default {};\n" });
      fixture.remove("app/vitest.config.ts");
      const client = yield* useClient(fixture);
      const kit = () =>
        call(function* () {
          const response = yield* call(() => client.generate(request(fixture, "app")));
          return rules(response.rules)["kit"];
        });
      expect(yield* kit()).not.toHaveProperty("config");
      fixture.remove("app/vite.config.ts");
      expect(yield* kit()).toMatchObject({ config: "vite.config.mts", tool_deps: [] });
      fixture.remove("app/vite.config.mts");
      const error = yield* failure(() => client.generate(request(fixture, "app")));
      expect(error).toMatchObject({
        code: Code.InvalidArgument,
        rawMessage:
          "app/node_modules/$app/tsconfig.json: SvelteKit generates this configuration from a Vite configuration, and //app has none",
      });
    }));

  test("the packages SvelteKit's declarations import must be bound unless deps are kept", () =>
    run(function* () {
      const fixture = yield* useFixture();
      const index = JSON.parse(fs.readFileSync(fixture.index, "utf8"));
      delete index.packages.app.bindings.svelte;
      fs.writeFileSync(fixture.index, JSON.stringify(index));
      const client = yield* useClient(fixture);
      const error = yield* failure(() => client.generate(request(fixture, "app")));
      expect(error).toMatchObject({
        code: Code.InvalidArgument,
        rawMessage:
          "app/node_modules/$app/tsconfig.json: SvelteKit's generated declarations import svelte; add it to //app's package.json, or declare it in deps and mark the attribute # keep",
      });
      const kept = rule("js_svelte_kit", "kit", { deps: ["//manual:svelte"] }, ["deps"]);
      const response = yield* call(() => client.generate(request(fixture, "app", [kept])));
      expect(rules(response.rules)["kit"]).toMatchObject({ kind: "js_svelte_kit" });
    }));

  test("the generated inputs never include .env files, which can hold secrets", () =>
    run(function* () {
      const fixture = yield* useFixture({
        "app/.env": "SECRET=1\n",
        "app/.env.production": "SECRET=2\n",
        "app/static/.env": "SECRET=3\n",
      });
      const client = yield* useClient(fixture);
      const response = yield* call(() => client.generate(request(fixture, "app")));
      expect(rules(response.rules)["kit"]?.["srcs"]).toEqual({
        glob: ["src/*", "src/lib/**", "src/routes/**", "static/**"],
        exclude: ["**/.*"],
        allowEmpty: true,
      });
    }));

  test("kit_tsconfig gives way to js_svelte_kit, and a created kit nothing extends is stale", () =>
    run(function* () {
      const fixture = yield* useFixture();
      const client = yield* useClient(fixture);
      const replaced = yield* call(() =>
        client.generate(
          request(fixture, "app", [
            rule("js_tsconfig", "kit_tsconfig", { config: "node_modules/$app/tsconfig.json" }),
          ]),
        ),
      );
      expect(replaced.staleRules.map(({ kind, name }) => `${kind}:${name}`)).toEqual([
        "js_tsconfig:kit_tsconfig",
      ]);
      fixture.write(
        "app/tsconfig.json",
        JSON.stringify({ extends: "../tsconfig.base.json", include: ["src/**/*.ts"] }),
      );
      const created = yield* call(() =>
        client.generate(request(fixture, "app", [rule("js_svelte_kit", "kit", {})])),
      );
      expect(created.staleRules.map(({ kind, name }) => `${kind}:${name}`)).toEqual([
        "js_svelte_kit:kit",
      ]);
      // An authored name stays the user's.
      const authored = yield* call(() =>
        client.generate(request(fixture, "app", [rule("js_svelte_kit", "sync", {})])),
      );
      expect(authored.staleRules).toEqual([]);
    }));

  test("an installed configuration is a package, not an inherited rule", () =>
    run(function* () {
      const fixture = yield* useFixture({
        "node_modules/typescript/package.json": '{"name": "typescript", "version": "0.0.0"}\n',
        "node_modules/typescript/tsconfig.shared.json":
          '{"compilerOptions": {"declarationMap": true}}\n',
        "lib/tsconfig.check.json": JSON.stringify({
          extends: "typescript/tsconfig.shared.json",
          include: ["src/**/*.ts"],
        }),
      });
      const client = yield* useClient(fixture);
      const response = yield* call(() => client.generate(request(fixture, "lib")));
      // No rule provides its options, so the extender declares them.
      expect(rules(response.rules)["check_tsconfig"]).toMatchObject({
        extends: [],
        compiler_options: { declarationMap: true },
      });
      expect(rules(response.rules)["check_tsconfig"]?.["deps"]).toContain(
        "@pnpm//node_modules/typescript",
      );
    }));

  test("extends follows the configuration's order, names and references interleaved", () =>
    run(function* () {
      const fixture = yield* useFixture({
        "lib/configs/extra.json": '{"compilerOptions": {"declarationMap": true}}\n',
        "lib/tsconfig.check.json": JSON.stringify({
          extends: ["./tsconfig.lib.json", "../tsconfig.base.json", "./configs/extra.json"],
          include: ["src/**/*.ts"],
        }),
      });
      const client = yield* useClient(fixture);
      const response = yield* call(() => client.generate(request(fixture, "lib")));
      expect(rules(response.rules)["check_tsconfig"]?.["extends"]).toEqual([
        ":lib_tsconfig",
        { reference: "file:tsconfig.base.json", fallback: "//:tsconfig.base.json" },
        ":extra_tsconfig",
      ]);
    }));

  test("existing consumers keep their names and Vitest traces its authored sources", () =>
    run(function* () {
      const fixture = yield* useFixture();
      const client = yield* useClient(fixture);
      const sources = concatenation([
        strings(["src/lib/format.test.ts", ":lib_tsc"]),
        glob(["src/**/*.svelte"], [], false),
      ]);
      const response = yield* call(() =>
        client.generate(
          request(fixture, "app", [
            rule("js_vite", "build", { config: ":vite_config", out: "dist" }),
            rule("js_vite", "preview", { config: "//app:vite_config", mode: "preview" }),
            rule("js_vitest", "unit_test", { config: ":vitest_config", srcs: sources }),
            rule("js_tsc", "lib_tsc", {}),
          ]),
        ),
      );
      const generated = rules(response.rules);
      expect(Object.keys(generated)).not.toContain("vite_build");
      expect(generated["build"]).toEqual({
        kind: "js_vite",
        config: ":vite_config",
        vite: "@pnpm//node_modules/vite:bin",
      });
      expect(generated["preview"]).toEqual({
        kind: "js_vite",
        config: ":vite_config",
        vite: "@pnpm//node_modules/vite:bin",
      });
      expect(generated["unit_test"]).toEqual({
        kind: "js_vitest",
        vitest: "@pnpm//node_modules/vitest:bin",
        coverage_provider: "@pnpm//node_modules/@vitest/coverage-v8",
        config: ":vitest_config",
        deps: [
          "src/lib/format.ts",
          "//lib",
          "@pnpm//node_modules/@sveltejs/kit",
          "@pnpm//node_modules/vitest",
          { reference: "file:app/generated/api.ts", fallback: "//app/generated:api.ts" },
        ],
        aliases: {},
      });
    }));

  test("Vitest sources must be files, globs or their concatenation unless deps are kept", () =>
    run(function* () {
      const fixture = yield* useFixture();
      const client = yield* useClient(fixture);
      const error = yield* failure(() =>
        client.generate(request(fixture, "app", [missingSources([])])),
      );
      expect(error).toBeInstanceOf(ConnectError);
      expect(error).toMatchObject({
        code: Code.InvalidArgument,
        rawMessage:
          "//app:unit_test: cannot trace dependencies:\n//app:unit_test: srcs names missing.test.ts, which is not a file of the package\nDeclare these inputs in deps and mark the attribute # keep.",
      });
      const response = yield* call(() =>
        client.generate(request(fixture, "app", [missingSources(["deps"])])),
      );
      expect(response.rules.map((item) => item.name)).toContain("unit_test");
    }));

  test("unresolved imports fail generation unless the attribute is kept", () =>
    run(function* () {
      const fixture = yield* useFixture({ "lib/src/unbound.ts": 'import "unbound";\n' });
      const client = yield* useClient(fixture);
      const error = yield* failure(() => client.generate(request(fixture, "lib")));
      expect(error).toMatchObject({
        code: Code.InvalidArgument,
        rawMessage: expect.stringContaining("lib/tsconfig.json: cannot trace dependencies:"),
      });
      const kept = [
        ["tsconfig", "tsconfig.json"],
        ["lib_tsconfig", "tsconfig.lib.json"],
        ["test_tsconfig", "tsconfig.test.json"],
      ].map(([name, config]) =>
        rule("js_tsconfig", name!, { config: config!, deps: ["//manual:unbound"] }, ["deps"]),
      );
      const response = yield* call(() => client.generate(request(fixture, "lib", kept)));
      expect(response.rules.length).toBeGreaterThan(0);
    }));

  test("a config's local imports are generated dependencies", () =>
    run(function* () {
      const fixture = yield* useFixture({
        "app/.storybook/plugins.ts": "export const plugins = [];\n",
        "app/.storybook/vite.config.ts":
          'import { plugins } from "./plugins.ts";\n\nexport default { plugins };\n',
      });
      const client = yield* useClient(fixture);
      const response = yield* call(() => client.generate(request(fixture, "app")));
      const generated = rules(response.rules);
      expect(generated["storybook_vite_config"]).toMatchObject({
        deps: [".storybook/plugins.ts"],
      });
      expect(generated["storybook_vite_config"]).not.toHaveProperty("srcs");
    }));

  test("a config's unresolved imports are declared in deps", () =>
    run(function* () {
      const fixture = yield* useFixture({
        "app/.storybook/vite.config.ts": 'import "unbound";\n\nexport default {};\n',
      });
      const client = yield* useClient(fixture);
      const error = yield* failure(() => client.generate(request(fixture, "app")));
      expect(error).toMatchObject({
        code: Code.InvalidArgument,
        rawMessage: expect.stringContaining(
          "app/.storybook/vite.config.ts: cannot trace dependencies:",
        ),
      });
      expect(error).toMatchObject({
        rawMessage: expect.stringContaining(
          "Declare these inputs in deps and mark the attribute # keep.",
        ),
      });
      const kept = rule(
        "js_vite_config",
        "storybook_vite_config",
        { config: ".storybook/vite.config.ts", deps: ["//manual:unbound"] },
        ["deps"],
      );
      const response = yield* call(() => client.generate(request(fixture, "app", [kept])));
      expect(response.rules.map((item) => item.name)).toContain("storybook_vite_config");
    }));

  test("the TypeScript directive selects the compiler and testonly carries to new compilations", () =>
    run(function* () {
      const fixture = yield* useFixture();
      const client = yield* useClient(fixture);
      const response = yield* call(() =>
        client.generate(
          request(
            fixture,
            "lib",
            [
              rule("js_tsconfig", "test_tsconfig", {
                config: "tsconfig.test.json",
                testonly: true,
              }),
              rule("js_tsc", "tsc", { config: ":tsconfig" }),
            ],
            [["js_typescript", "@pnpm//node_modules/@typescript/next"]],
          ),
        ),
      );
      const generated = rules(response.rules);
      expect(generated["test_tsc"]).toEqual({
        kind: "js_tsc",
        tsc: "@pnpm//node_modules/@typescript/native:tsc",
        config: ":test_tsconfig",
        typescript: "@pnpm//node_modules/@typescript/next",
        testonly: true,
        visibility,
      });
      expect(generated["tsc"]).toEqual({
        kind: "js_tsc",
        tsc: "@pnpm//node_modules/@typescript/native:tsc",
        config: ":tsconfig",
        typescript: "@pnpm//node_modules/@typescript/next",
      });
      expect(generated["test_tsconfig"]).not.toHaveProperty("visibility");
    }));

  test("canonical rules whose configuration is gone are stale and authored ones stay", () =>
    run(function* () {
      const fixture = yield* useFixture();
      const client = yield* useClient(fixture);
      const response = yield* call(() =>
        client.generate(
          request(fixture, "lib", [
            rule("js_tsconfig", "old_tsconfig", { config: "tsconfig.old.json" }),
            rule("js_tsc", "old_tsc", { config: ":old_tsconfig" }),
            rule("js_tsconfig", "renamed", { config: "tsconfig.gone.json" }),
            rule("js_tsc", "compile", { config: ":renamed" }),
            rule("js_vite_config", "vite_config", { config: "vite.config.ts" }),
            rule("js_vite", "vite_build", { config: ":vite_config" }),
            rule("js_vite_config", "legacy_config", { config: "vite.legacy.config.ts" }),
            rule("js_vite", "legacy", { config: ":legacy_config" }),
            rule("js_storybook", "storybook", { config_dir: ".storybook" }),
            rule("js_storybook", "docs", { config_dir: "docs" }),
            rule("js_storybook", "labelled", { config_dir: ":docs" }),
            rule("js_vite_config", "shared_config", { config: "//app:vite.config.ts" }),
            rule("filegroup", "files", { srcs: ["tsconfig.old.json"] }),
          ]),
        ),
      );
      expect(response.staleRules.map(({ kind, name }) => `${kind}:${name}`)).toEqual([
        "js_tsconfig:old_tsconfig",
        "js_tsc:old_tsc",
        "js_vite_config:vite_config",
        "js_vite:vite_build",
        "js_storybook:storybook",
      ]);
      const names = response.rules.map((item) => item.name);
      for (const name of ["renamed", "compile", "legacy_config", "legacy", "docs", "labelled"]) {
        expect(names).not.toContain(name);
      }
    }));

  test("a Storybook without a main module yields to the canonical one in one run", () =>
    run(function* () {
      const fixture = yield* useFixture();
      const client = yield* useClient(fixture);
      const existing = [
        rule("js_storybook", "docs", { config_dir: "docs" }),
        rule("js_tsc", "legacy_tsc", { config: ":legacy_tsconfig" }),
      ];
      const first = yield* call(() => client.generate(request(fixture, "app", existing)));
      expect(rules(first.rules)["storybook"]).toMatchObject({
        config_dir: ".storybook",
        testonly: true,
      });
      // A compilation whose configuration rule no longer exists is stale.
      expect(first.staleRules.map(({ kind, name }) => `${kind}:${name}`)).toEqual([
        "js_tsc:legacy_tsc",
      ]);
      const second = yield* call(() =>
        client.generate(request(fixture, "app", applied(existing, first))),
      );
      // Order only places new rules, so the second run is compared as a set.
      expect(second.rules.map((item) => `${item.kind}:${item.name}`).toSorted()).toEqual(
        first.rules.map((item) => `${item.kind}:${item.name}`).toSorted(),
      );
      expect(second.staleRules).toEqual([]);
      expect(rules(second.rules)["storybook"]).toMatchObject({ config_dir: ".storybook" });
    }));

  test("a js_vitest whose configuration is gone is an input error, never stale", () =>
    run(function* () {
      const fixture = yield* useFixture();
      const client = yield* useClient(fixture);
      const sources = { srcs: ["src/value.test.ts"] };
      const provider = rule("js_vite_config", "legacy_config", {
        config: "vite.legacy.config.ts",
      });
      const gone = yield* failure(() =>
        client.generate(
          request(fixture, "lib", [
            provider,
            rule("js_vitest", "unit_test", { config: ":legacy_config", ...sources }),
          ]),
        ),
      );
      expect(gone).toMatchObject({
        code: Code.InvalidArgument,
        rawMessage:
          "//lib:unit_test: its config :legacy_config names lib/vite.legacy.config.ts, which no longer exists; point the js_vitest rule at an existing Vitest config or remove it",
      });
      const unnamed = yield* failure(() =>
        client.generate(
          request(fixture, "lib", [
            rule("js_vitest", "unit_test", { config: ":nothing", ...sources }),
          ]),
        ),
      );
      expect(unnamed).toMatchObject({
        code: Code.InvalidArgument,
        rawMessage: expect.stringContaining("its config :nothing names no rule of the package"),
      });
      const kept = rule("js_vitest", "unit_test", { config: ":legacy_config", ...sources }, [""]);
      const response = yield* call(() =>
        client.generate(request(fixture, "lib", [provider, kept])),
      );
      expect(response.staleRules).toEqual([]);
    }));

  test("unexpected failures are internal errors with their cause", () =>
    run(function* () {
      const fixture = yield* useFixture();
      const service = createService({ index: fixture.index, loads });
      const context = createHandlerContext({
        service: LanguageService,
        method: LanguageService.method.generate,
        protocolName: "connect",
        requestMethod: "POST",
        url: "http://gazelle/gazelle.v1.LanguageService/Generate",
      });
      yield* call(
        async () =>
          await service.initialize!(
            { $typeName: "gazelle.v1.InitializeRequest", repositoryRoot: fixture.root },
            context,
          ),
      );
      const stale = request(fixture, "lib");
      // The inventory names a config that disappeared from disk.
      fixture.remove("lib/vitest.config.ts");
      const error = yield* failure(() => Promise.resolve(service.generate!(stale, context)));
      expect(error).toBeInstanceOf(ConnectError);
      expect(error).toMatchObject({
        code: Code.Internal,
        cause: expect.objectContaining({ code: "ENOENT" }),
      });
    }));
});

describe("Check tests", () => {
  // The repository root's directives.
  const directives = [
    ["js_check", "js_oxlint_test //:.oxlintrc.json //:.gitignore //:tsconfig.base.json"],
    ["js_check", "js_oxfmt_test //:.oxfmtrc.json //:.gitignore //:.prettierignore"],
    [
      "js_check",
      "js_prettier_test //:.prettierrc.json //:.prettierignore @pnpm//node_modules/prettier-plugin-svelte",
    ],
    ["js_check", "js_knip_test //:.gitignore //:pnpm-workspace.yaml"],
  ] as const;

  test("are created without visibility and read after Storybook, before compilations", () =>
    run(function* () {
      const fixture = yield* useFixture({ "app/knip.json": "{}\n" });
      const client = yield* useClient(fixture);
      const response = yield* call(() => client.generate(request(fixture, "app", [], directives)));
      expect(response.rules.map((item) => item.name)).toEqual([
        "vite_build",
        "vite_config",
        "storybook",
        "storybook_vite_config",
        "oxlint_test",
        // Each test is followed by the configurations it stages.
        "tsconfig",
        "kit",
        "oxfmt_test",
        "prettier_test",
        "knip_test",
        "vitest_config",
        "knip_production_test",
        "tsc",
      ]);
      const generated = rules(response.rules);
      expect(generated["oxlint_test"]).toEqual({
        kind: "js_oxlint_test",
        oxlint: "@pnpm//node_modules/oxlint:bin",
        srcs: {
          glob: ["*.ts", ".storybook/**/*.ts", "src/**/*.svelte", "src/**/*.ts", "tsconfig*.json"],
          exclude: [],
          allowEmpty: false,
        },
        data: ["//:.gitignore", "//:.oxlintrc.json", "//:tsconfig.base.json"],
        // The configurations stage SvelteKit's generated files through :kit.
        deps: [":tsconfig"],
      });
      expect(generated["prettier_test"]).toEqual({
        kind: "js_prettier_test",
        prettier: "@pnpm//node_modules/prettier:bin",
        srcs: { glob: ["src/**/*.svelte"], exclude: [], allowEmpty: false },
        data: [
          "//:.prettierignore",
          "//:.prettierrc.json",
          "@pnpm//node_modules/prettier-plugin-svelte",
        ],
        deps: [],
        paths: ["src/**/*.svelte"],
      });
      expect(generated["knip_production_test"]).toMatchObject({
        workspace: "@fixture/app",
        production: true,
        deps: [":storybook_vite_config", ":tsconfig", ":vite_config", ":vitest_config"],
      });
    }));

  test("a second generation over created check tests reproduces them", () =>
    run(function* () {
      const fixture = yield* useFixture({ "app/knip.json": "{}\n" });
      const client = yield* useClient(fixture);
      const first = yield* call(() => client.generate(request(fixture, "app", [], directives)));
      const second = yield* call(() =>
        client.generate(request(fixture, "app", applied([], first), directives)),
      );
      expect(second.staleRules).toEqual([]);
      const once = rules(first.rules);
      const twice = rules(second.rules);
      // Created paths are authored from then on, and srcs follow them.
      const { paths, prettier: tool, ...prettier } = once["prettier_test"]!;
      expect(tool).toEqual("@pnpm//node_modules/prettier:bin");
      expect(paths).toEqual(["src/**/*.svelte"]);
      expect(twice["prettier_test"]).toEqual(prettier);
      for (const name of ["oxlint_test", "oxfmt_test", "knip_test", "knip_production_test"]) {
        expect(twice[name]).toEqual(
          Object.fromEntries(
            Object.entries(once[name]!).filter(
              ([key]) => !["oxlint", "oxfmt", "knip"].includes(key),
            ),
          ),
        );
      }
    }));

  test("are stale once their directive is off or their Svelte files or knip.json are gone", () =>
    run(function* () {
      const fixture = yield* useFixture({ "app/knip.json": "{}\n" });
      const client = yield* useClient(fixture);
      const first = yield* call(() => client.generate(request(fixture, "app", [], directives)));
      fixture.remove("app/knip.json");
      fixture.remove("app/src/lib/widget.svelte");
      fixture.remove("app/src/routes/+page.svelte");
      // An authored name is never stale.
      const authored = rule("js_oxlint_test", "lint_test", { paths: ["src"] });
      const response = yield* call(() =>
        client.generate(
          request(
            fixture,
            "app",
            [...applied([], first), authored],
            [...directives, ["js_check", "js_oxlint_test off"]],
          ),
        ),
      );
      expect(response.staleRules.map(({ kind, name }) => `${kind}:${name}`)).toEqual([
        "js_oxlint_test:oxlint_test",
        "js_prettier_test:prettier_test",
        "js_knip_test:knip_test",
        "js_knip_test:knip_production_test",
      ]);
      expect(response.rules.map((item) => item.name)).toContain("oxfmt_test");
      // The repository root never has generated check tests.
      const root = yield* call(() =>
        client.generate(
          request(
            fixture,
            "",
            [
              rule(
                "js_tsconfig",
                "base_tsconfig",
                { config: "tsconfig.base.json", srcs: strings([]) },
                ["srcs"],
              ),
              rule("js_oxlint_test", "oxlint_test", {}),
            ],
            directives,
          ),
        ),
      );
      expect(root.rules.map((item) => item.name)).toEqual(["base_tsconfig"]);
      expect(root.staleRules).toEqual([]);
    }));

  test("paths that srcs cannot follow fail generation unless srcs is kept", () =>
    run(function* () {
      const fixture = yield* useFixture();
      const client = yield* useClient(fixture);
      const error = yield* failure(() =>
        client.generate(request(fixture, "lib", [bracedPaths([])], directives)),
      );
      expect(error).toMatchObject({
        code: Code.InvalidArgument,
        rawMessage:
          '//lib:oxfmt_test: cannot trace dependencies:\n//lib:oxfmt_test: paths names src/{a,b}, which is neither ".", a directory or file of the package nor a glob of literal segments, * and **\nDeclare these inputs in srcs and mark the attribute # keep.',
      });
      const response = yield* call(() =>
        client.generate(request(fixture, "lib", [bracedPaths(["srcs"])], directives)),
      );
      expect(response.rules.map((item) => item.name)).toContain("oxfmt_test");
    }));
});

describe("Index", () => {
  test("configuration rules provide their config files, in any package", () =>
    run(function* () {
      const fixture = yield* useFixture();
      const client = yield* useClient(fixture);
      const response = yield* call(() =>
        client.index({
          package: "tools/other",
          rules: [
            rule("js_tsconfig", "base_tsconfig", { config: "tsconfig.base.json" }),
            rule("js_vite_config", "shared_config", { config: ":vite.config.ts" }),
            rule("js_tsconfig", "moved_tsconfig", { config: "//configs:tsconfig.json" }),
            rule("js_tsc", "tsc", { config: ":base_tsconfig" }),
            rule("js_tsconfig", "installed_tsconfig", {
              config: "@pnpm//node_modules/@tsconfig/node:tsconfig.json",
            }),
          ],
        }),
      );
      expect(
        response.rules.map((item) => [
          item.name,
          item.imports.map((spec) => [spec.language, spec.import]),
        ]),
      ).toEqual([
        ["base_tsconfig", [["", "file:tools/other/tsconfig.base.json"]]],
        ["shared_config", [["", "file:tools/other/vite.config.ts"]]],
        ["moved_tsconfig", [["", "file:configs/tsconfig.json"]]],
      ]);
    }));
});

describe("consumer load maps and tool bindings", () => {
  test.for([
    [{ kind: "unknown_rule", label: "@ts//ts:defs.bzl" }],
    [
      { kind: "js_tsc", label: "@ts//ts:defs.bzl" },
      { kind: "js_tsc", label: "@other//custom:defs.bzl" },
    ],
    [{ kind: "js_tsc", label: "relative.bzl" }],
    [{ kind: "js_tsc", label: "@ts//ts:defs.bzl", extra: true }],
  ])("rejects malformed or ambiguous maps %j", (entries) =>
    run(function* () {
      const fixture = yield* useFixture();
      expect(() => createService({ index: fixture.index, loads: entries })).toThrow();
    }),
  );

  test("a partial TS map groups symbols and generates only mapped kinds", () =>
    run(function* () {
      const fixture = yield* useFixture();
      const selected = [
        { kind: "js_tsconfig", label: "@custom_js//js:defs.bzl" },
        { kind: "js_tsc", label: "@custom_js//js:defs.bzl" },
      ];
      const client = createClient(
        LanguageService,
        createRouterTransport((router) =>
          router.service(LanguageService, createService({ index: fixture.index, loads: selected })),
        ),
      );
      const initialized = yield* call(() => client.initialize({ repositoryRoot: fixture.root }));
      expect(initialized.loads).toMatchObject([
        { label: "@custom_js//js:defs.bzl", symbols: ["js_tsc", "js_tsconfig"] },
      ]);
      const response = yield* call(() => client.generate(request(fixture, "")));
      expect(response.rules.length).toBeGreaterThan(0);
      expect(response.rules.every((item) => selected.some(({ kind }) => kind === item.kind))).toBe(
        true,
      );
      const error = yield* failure(() => client.generate(request(fixture, "lib")));
      expect(error).toMatchObject({ code: Code.InvalidArgument });
      expect(String(error)).toContain("no load-map entry for generated kind");
    }));

  test("uses an allocated compiler command instead of guessing bin", () =>
    run(function* () {
      const fixture = yield* useFixture();
      const index = JSON.parse(fs.readFileSync(fixture.index, "utf8"));
      index.packages.lib.bindings["@typescript/native"].binaries.tsc =
        "@npm//node_modules/@typescript/native:allocated_compiler";
      fixture.write("workspace.json", JSON.stringify(index));
      const client = yield* useClient(fixture);
      const response = yield* call(() => client.generate(request(fixture, "lib")));
      expect(rules(response.rules)["lib_tsc"]).toMatchObject({
        tsc: "@npm//node_modules/@typescript/native:allocated_compiler",
      });
    }));

  test.for([
    scalar("@manual//:compiler"),
    create(ValueSchema, {
      value: {
        case: "select",
        value: {
          cases: [{ condition: "//conditions:default", value: scalar("@manual//:compiler") }],
        },
      },
    }),
    create(ValueSchema, { value: { case: "opaque", value: {} } }),
  ])("authored compiler expressions bypass absent command lookup %j", (value) =>
    run(function* () {
      const fixture = yield* useFixture();
      const index = JSON.parse(fs.readFileSync(fixture.index, "utf8"));
      delete index.packages.lib.bindings["@typescript/native"].binaries.tsc;
      fixture.write("workspace.json", JSON.stringify(index));
      const client = yield* useClient(fixture);
      const existing = [
        rule("js_tsc", "lib_tsc", { config: ":lib_tsconfig", tsc: value }),
        rule("js_tsc", "tsc", { config: ":tsconfig", tsc: value }),
        rule("js_tsc", "test_tsc", { config: ":test_tsconfig", tsc: value }),
      ];
      const response = yield* call(() => client.generate(request(fixture, "lib", existing)));
      for (const item of response.rules.filter(({ kind }) => kind === "js_tsc")) {
        expect(item.attributes["tsc"]).toBeUndefined();
      }
    }),
  );

  test("an absent compiler command fails instead of emitting a guessed label", () =>
    run(function* () {
      const fixture = yield* useFixture();
      const index = JSON.parse(fs.readFileSync(fixture.index, "utf8"));
      delete index.packages.lib.bindings["@typescript/native"].binaries.tsc;
      fixture.write("workspace.json", JSON.stringify(index));
      const client = yield* useClient(fixture);
      const error = yield* failure(() => client.generate(request(fixture, "lib")));
      expect(error).toMatchObject({ code: Code.InvalidArgument });
      expect(String(error)).toContain("missing installed tool @typescript/native command tsc");
    }));
});
