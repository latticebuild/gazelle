import { Code } from "@connectrpc/connect";
import { run } from "effection";
import { describe, expect, test } from "vitest";

import { rule, useFixture } from "../tests/support/fixture.js";
import { discoverProviders, discoverStorybooks, typecheckConfigs, vitestConfigs } from "./vite.js";

describe("providers", () => {
  test("conventional configs are named after their files", () =>
    run(function* () {
      const fixture = yield* useFixture();
      const providers = discoverProviders(fixture.pkg("app"));
      expect(providers.map(({ local, name }) => [local, name])).toEqual([
        [".storybook/vite.config.ts", "storybook_vite_config"],
        ["vite.config.ts", "vite_config"],
        ["vitest.config.ts", "vitest_config"],
      ]);
    }));

  test("existing rules name their configs, including unconventional ones", () =>
    run(function* () {
      const fixture = yield* useFixture({ "app/vite.lib.config.ts": "export default {};" });
      const pkg = fixture.pkg("app", [
        rule("js_vite_config", "build_config", { config: "vite.config.ts" }),
        rule("js_vite_config", "library_config", { config: "vite.lib.config.ts" }),
        rule("js_vitest", "unit_test", { config: ":library_config" }),
      ]);
      const providers = discoverProviders(pkg);
      expect(providers.map(({ local, name }) => [local, name])).toEqual([
        [".storybook/vite.config.ts", "storybook_vite_config"],
        ["vite.config.ts", "build_config"],
        ["vite.lib.config.ts", "library_config"],
        ["vitest.config.ts", "vitest_config"],
      ]);
      expect(vitestConfigs(pkg, providers)).toEqual(["vite.lib.config.ts", "vitest.config.ts"]);
    }));

  test("two rules on one config are an input error", () =>
    run(function* () {
      const fixture = yield* useFixture();
      const pkg = fixture.pkg("app", [
        rule("js_vite_config", "a", { config: "vite.config.ts" }),
        rule("js_vite_config", "b", { config: "vite.config.ts" }),
      ]);
      expect(() => discoverProviders(pkg)).toThrow(
        expect.objectContaining({ code: Code.InvalidArgument }),
      );
    }));

  test("Storybook directories come from existing rules or the convention", () =>
    run(function* () {
      const fixture = yield* useFixture({ "app/stories/main.ts": "export default {};" });
      expect(
        discoverStorybooks(fixture.pkg("app")).map(({ name, directory, main }) => [
          name,
          directory,
          main,
        ]),
      ).toEqual([["storybook", ".storybook", ".storybook/main.ts"]]);
      const pkg = fixture.pkg("app", [
        rule("js_storybook", "stories", { config_dir: "stories" }),
        rule("js_storybook", "gone", { config_dir: "missing" }),
      ]);
      expect(discoverStorybooks(pkg).map(({ name, directory }) => [name, directory])).toEqual([
        ["stories", "stories"],
      ]);
      // A rule without a main module does not stand in for the canonical one.
      const gone = fixture.pkg("app", [rule("js_storybook", "gone", { config_dir: "missing" })]);
      expect(discoverStorybooks(gone).map(({ name, directory }) => [name, directory])).toEqual([
        ["storybook", ".storybook"],
      ]);
      // A directory given as a label is authored; nothing is maintained or created.
      const labelled = fixture.pkg("app", [rule("js_storybook", "docs", { config_dir: ":docs" })]);
      expect(discoverStorybooks(labelled)).toEqual([]);
    }));
});

describe("typecheckConfigs", () => {
  test.for([
    {
      name: "a literal tsconfig",
      config:
        'export default { test: { typecheck: { enabled: true, tsconfig: "configs/check.json" } } };',
    },
    {
      name: "a mode condition in a config factory",
      config: [
        'import { defineConfig } from "vitest/config";',
        "export default defineConfig(({ mode }) => ({",
        '  test: { typecheck: { enabled: mode === "test", tsconfig: mode === "test" ? "configs/check.json" : "tsconfig.json" } },',
        "}));",
      ].join("\n"),
    },
    {
      name: "an inline project inheriting imported settings",
      config: [
        'import { typecheck } from "./settings.ts";',
        'export default { test: { typecheck, projects: [{ extends: true, test: { name: "unit" } }] } };',
      ].join("\n"),
    },
    {
      name: "a file project",
      config: 'export default { test: { projects: ["configs/vitest.config.ts"] } };',
    },
  ])("finds $name", ({ config }) =>
    run(function* () {
      const fixture = yield* useFixture({
        "lib/vitest.config.ts": config,
        "lib/settings.ts":
          'export const typecheck = { enabled: true, tsconfig: "configs/check.json" };',
        "lib/configs/vitest.config.ts":
          'export default { test: { typecheck: { enabled: true, tsconfig: "check.json" } } };',
        "lib/configs/check.json": "{}",
      });
      expect(typecheckConfigs(fixture.pkg("lib"), ["vitest.config.ts"])).toEqual([
        "configs/check.json",
      ]);
    }),
  );

  test("without a tsconfig, Vitest's lookup from the project root applies", () =>
    run(function* () {
      const fixture = yield* useFixture({
        "lib/vitest.config.ts": "export default { test: { typecheck: { enabled: true } } };",
      });
      expect(typecheckConfigs(fixture.pkg("lib"), ["vitest.config.ts"])).toEqual(["tsconfig.json"]);
    }));

  test("computed and disabled settings select nothing", () =>
    run(function* () {
      const fixture = yield* useFixture({
        "lib/vitest.config.ts": [
          "export default {",
          "  test: { typecheck: { enabled: process.env.CHECK === '1', tsconfig: process.env.TSCONFIG } },",
          "};",
        ].join("\n"),
      });
      expect(typecheckConfigs(fixture.pkg("lib"), ["vitest.config.ts"])).toEqual([]);
    }));
});
