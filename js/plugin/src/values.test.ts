import { call, run } from "effection";
import { describe, expect, test } from "vitest";

import { plain } from "../tests/support/fixture.js";
import { Dependencies, localName, relativeLabel } from "./values.js";

describe("labels", () => {
  test.for([
    ["//app:vite_config", "app", ":vite_config"],
    ["//:base_tsconfig", "", ":base_tsconfig"],
    ["//javascript/base:base", "app", "//javascript/base"],
    ["@//javascript/base:lib", "app", "//javascript/base:lib"],
    ["@pnpm//node_modules/vitest", "app", "@pnpm//node_modules/vitest"],
  ] as const)("%s is written %s in //%s", ([label, pkg, expected]) =>
    run(function* () {
      yield* call(() => {
        expect(relativeLabel(label, pkg)).toBe(expected);
      });
    }),
  );

  test.for([
    [":vite_config", "app", "vite_config"],
    ["vite.config.ts", "app", "vite.config.ts"],
    ["//app:tsconfig", "app", "tsconfig"],
    ["//app", "app", "app"],
    ["//lib:tsconfig", "app", undefined],
    ["@pnpm//node_modules/vitest", "app", undefined],
  ] as const)("%s names %s in //%s", ([label, pkg, expected]) =>
    run(function* () {
      yield* call(() => {
        expect(localName(label, pkg)).toBe(expected);
      });
    }),
  );
});

describe("Dependencies", () => {
  test("renders platform-specific labels as a select after the unconditional list", () =>
    run(function* () {
      yield* call(() => {
        const deps = new Dependencies();
        deps.add("@pnpm//node_modules/vitest");
        deps.add("@pnpm//node_modules/fsevents", ["@//gazelle/platforms:darwin_arm64"]);
        deps.add("//app:vite_config");
        deps.reference("tsconfig.base.json", "//:tsconfig.base.json");
        expect(plain(deps.value("app"))).toEqual({
          concatenation: [
            [
              ":vite_config",
              "@pnpm//node_modules/vitest",
              { reference: "file:tsconfig.base.json", fallback: "//:tsconfig.base.json" },
            ],
            {
              select: {
                "//gazelle/platforms:darwin_arm64": ["@pnpm//node_modules/fsevents"],
                "//conditions:default": [],
              },
            },
          ],
        });
      });
    }));

  test("sorts labels as buildifier does", () =>
    run(function* () {
      yield* call(() => {
        const deps = new Dependencies();
        for (const label of [
          "@pnpm//node_modules/a",
          "//:tsconfig.base.json",
          "//app:b",
          "tsconfig.lib.json",
        ]) {
          deps.add(label);
        }
        expect(plain(deps.value("app"))).toEqual([
          "tsconfig.lib.json",
          ":b",
          "//:tsconfig.base.json",
          "@pnpm//node_modules/a",
        ]);
      });
    }));

  test("an unconditional use replaces platform conditions", () =>
    run(function* () {
      yield* call(() => {
        const deps = new Dependencies();
        deps.add("@pnpm//node_modules/fsevents", ["@//gazelle/platforms:darwin_arm64"]);
        deps.add("@pnpm//node_modules/fsevents");
        deps.add("@pnpm//node_modules/fsevents", ["@//gazelle/platforms:linux_x64_glibc"]);
        expect(plain(deps.value(""))).toEqual(["@pnpm//node_modules/fsevents"]);
      });
    }));
});
